import type { ScopedDb } from '@dripmetric/db';
import { scrubSample, MAX_DISTINCT_FOR_SAMPLE } from '@dripmetric/engine';

/**
 * The facts the mapping prompt and the Inbox are built from (brief §7).
 *
 * "Input: the distinct raw event names (top 60 by volume), their property keys,
 * shape-only samples (the type, and a value only when the property has few distinct
 * short values), typical position in user sequences."
 *
 * This is a job, not part of the ingest hot path, for three reasons:
 *
 *  - The scrubber runs ONCE per property here, where it can be tested, instead of on
 *    every event. Ingest stays plain parameterised SQL and batched inserts.
 *  - Sequence position and distinct-user counts need a scan of a person's whole
 *    history. One event cannot know where it falls in a sequence.
 *  - It is re-runnable. When the scrubber improves, the stored samples can be
 *    rebuilt — which would be impossible if they had been scrubbed on the way in and
 *    the original values thrown away.
 *
 * Every sample that leaves this file has been through `scrubSample`, and the prompt
 * builder scrubs again before the prompt exists. Two gates, because one of them
 * failing silently is the whole risk (brief §7: never send end-user personal data).
 */

/** Events sampled per name when reading property shapes. Bounded, not exhaustive. */
export const PROPERTY_SAMPLE_PER_NAME = 200;
/**
 * People sampled when working out where a name falls in a sequence.
 *
 * A bounded set of WHOLE sequences, not a bounded set of events: truncating events
 * would cut sequences in half and every position after the cut would be wrong.
 */
export const SEQUENCE_SAMPLE_USERS = 500;

export interface DictionaryFactsResult {
  namesSeen: number;
  propertiesWritten: number;
  /** Properties whose sample was withheld, and why. Audited, and testable. */
  withheld: { property: string; reason: string }[];
}

export async function refreshDictionaryFacts(
  db: ScopedDb,
  now: Date,
  options: { perName?: number; users?: number } = {},
): Promise<DictionaryFactsResult> {
  const perName = options.perName ?? PROPERTY_SAMPLE_PER_NAME;
  const users = options.users ?? SEQUENCE_SAMPLE_USERS;

  const withheld = await refreshProperties(db, now, perName);
  const namesSeen = await refreshNameStats(db, users);

  return { namesSeen, propertiesWritten: withheld.written, withheld: withheld.withheld };
}

interface PropertyRow {
  name_id: number;
  property: string;
  value_type: string;
  seen_count: string;
  distinct_values: string;
  /** Candidate values, already bounded by the query. Not yet scrubbed. */
  candidates: (string | null)[];
}

async function refreshProperties(
  db: ScopedDb,
  now: Date,
  perName: number,
): Promise<{ written: number; withheld: { property: string; reason: string }[] }> {
  /*
   * One statement, bounded per name by the lateral join, which uses
   * `events_project_name_time_idx`. A global `LIMIT` would have been simpler and
   * wrong: it would sample only the busiest names and leave the rare ones — the ones
   * most likely to be sitting unmapped in the Inbox — with no properties at all.
   */
  const rows = await db.query<PropertyRow>(
    `WITH pairs AS (
       SELECT n.id AS name_id,
              p.key AS property,
              jsonb_typeof(p.value) AS value_type,
              CASE WHEN jsonb_typeof(p.value) = 'string'
                   THEN p.value #>> '{}'
                   ELSE p.value::text
              END AS text_value
         FROM event_names n
         CROSS JOIN LATERAL (
           SELECT e.props
             FROM events e
            WHERE e.project_id = n.project_id
              AND e.name_id = n.id
              AND e.props IS NOT NULL
            ORDER BY e.occurred_at DESC
            LIMIT $2
         ) s
         CROSS JOIN LATERAL jsonb_each(s.props) p
        WHERE n.project_id = $1
     )
     SELECT name_id,
            property,
            mode() WITHIN GROUP (ORDER BY value_type) AS value_type,
            count(*)::text AS seen_count,
            count(DISTINCT text_value)::text AS distinct_values,
            (array_agg(DISTINCT text_value))[1:$3::int] AS candidates
       FROM pairs
      GROUP BY name_id, property`,
    [db.projectId, perName, MAX_DISTINCT_FOR_SAMPLE],
  );

  if (rows.length === 0) return { written: 0, withheld: [] };

  const withheld: { property: string; reason: string }[] = [];
  const samples: (string | null)[] = [];

  for (const row of rows) {
    const distinctValues = Number(row.distinct_values);
    // The first candidate is representative enough: the point is the SHAPE, and a
    // property with many distinct values has its sample withheld anyway.
    const candidate = row.candidates.find((value) => value !== null) ?? null;
    const result = scrubSample(row.property, candidate, distinctValues);
    if (result.reason !== null && candidate !== null) {
      withheld.push({ property: row.property, reason: result.reason });
    }
    samples.push(result.value);
  }

  await db.exec(
    `INSERT INTO event_name_properties
       (project_id, name_id, property, value_type, sample, distinct_values, seen_count,
        first_seen_at, last_seen_at)
     SELECT $1, f.name_id, f.property, f.value_type, f.sample, f.distinct_values,
            f.seen_count, $8, $8
       FROM unnest($2::int[], $3::text[], $4::text[], $5::text[], $6::int[], $7::bigint[])
            AS f(name_id, property, value_type, sample, distinct_values, seen_count)
     ON CONFLICT (project_id, name_id, property) DO UPDATE SET
       value_type      = EXCLUDED.value_type,
       sample          = EXCLUDED.sample,
       distinct_values = EXCLUDED.distinct_values,
       seen_count      = EXCLUDED.seen_count,
       last_seen_at    = EXCLUDED.last_seen_at,
       /*
        * Keep the type we are replacing, so shape drift is detectable (M11).
        *
        * Without this the row only ever holds the CURRENT type, so a property that
        * changes from a number to a string simply overwrites and the change is
        * invisible. Only a real change is recorded, and the old row's
        * seen_count goes with it, because a property seen twice as a number before
        * settling as a string is a founder fixing their own bug and not drift worth
        * alerting on.
        */
       prior_value_type = CASE
         WHEN event_name_properties.value_type IS DISTINCT FROM EXCLUDED.value_type
           THEN event_name_properties.value_type
         ELSE event_name_properties.prior_value_type
       END,
       prior_seen_count = CASE
         WHEN event_name_properties.value_type IS DISTINCT FROM EXCLUDED.value_type
           THEN event_name_properties.seen_count
         ELSE event_name_properties.prior_seen_count
       END,
       type_changed_at = CASE
         WHEN event_name_properties.value_type IS DISTINCT FROM EXCLUDED.value_type
           THEN EXCLUDED.last_seen_at
         ELSE event_name_properties.type_changed_at
       END`,
    [
      db.projectId,
      rows.map((r) => r.name_id),
      rows.map((r) => r.property),
      rows.map((r) => r.value_type),
      samples,
      rows.map((r) => Number(r.distinct_values)),
      rows.map((r) => r.seen_count),
      now,
    ],
  );

  return { written: rows.length, withheld };
}

/**
 * How many people send each name, and where it falls in their sequence.
 *
 * Position is most of what tells "Signed Up" from "Subscription Started" when the
 * names are the founder's own, and a name one person sent once is not a core action
 * whatever it is called.
 *
 * The reach is exact; the median position is taken over a bounded sample of whole
 * sequences, because it only has to be good enough to order the events of a typical
 * journey.
 */
async function refreshNameStats(db: ScopedDb, users: number): Promise<number> {
  const rows = await db.query<{
    name_id: number;
    distinct_users: string;
    median_position: string | null;
  }>(
    `WITH sampled_users AS (
       SELECT user_key
         FROM events
        WHERE project_id = $1 AND user_key IS NOT NULL
        GROUP BY user_key
        ORDER BY max(occurred_at) DESC
        LIMIT $2
     ), ranked AS (
       SELECT e.name_id,
              row_number() OVER (
                PARTITION BY e.user_key ORDER BY e.occurred_at, e.message_hash
              ) AS position
         FROM events e
         JOIN sampled_users u ON u.user_key = e.user_key
        WHERE e.project_id = $1
     ), positions AS (
       SELECT name_id,
              (percentile_cont(0.5) WITHIN GROUP (ORDER BY position))::text AS median_position
         FROM ranked
        GROUP BY name_id
     ), reach AS (
       -- Counted over EVERY event, not the sample: "how many people have ever sent
       -- this" is a fact the founder reads, so an estimate would be a wrong number
       -- rather than an approximate one.
       SELECT name_id, count(DISTINCT user_key)::text AS distinct_users
         FROM events
        WHERE project_id = $1 AND user_key IS NOT NULL
        GROUP BY name_id
     )
     SELECT r.name_id, r.distinct_users, p.median_position
       FROM reach r
       LEFT JOIN positions p ON p.name_id = r.name_id`,
    [db.projectId, users],
  );

  if (rows.length === 0) return 0;

  await db.exec(
    `UPDATE event_names SET
       distinct_users = s.distinct_users,
       median_sequence_position = s.median_position
     FROM unnest($2::int[], $3::int[], $4::numeric[])
          AS s(name_id, distinct_users, median_position)
     WHERE event_names.project_id = $1 AND event_names.id = s.name_id`,
    [
      db.projectId,
      rows.map((r) => r.name_id),
      rows.map((r) => Number(r.distinct_users)),
      rows.map((r) => r.median_position),
    ],
  );

  return rows.length;
}

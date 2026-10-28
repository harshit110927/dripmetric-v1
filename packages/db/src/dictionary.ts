import type { ScopedDb } from './scope.js';

/**
 * The event dictionary and the Inbox (brief §7, settled decision 10).
 *
 * "Unmapped events are stored and visible in the Inbox, but count toward nothing
 * until mapped." That sentence is the whole design: an event we do not understand is
 * never silently folded into a number. It waits where the founder can see it.
 */

export type EventNameStatus = 'unmapped' | 'suggested' | 'confirmed' | 'ignored';
export type SuggestionConfidence = 'high' | 'medium' | 'low';

export interface DictionaryEntry {
  id: number;
  rawName: string;
  canonical: string | null;
  status: EventNameStatus;
  confidence: SuggestionConfidence | null;
  reason: string | null;
  eventCount: number;
  distinctUsers: number;
  medianSequencePosition: number | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  owningSource: string | null;
  properties: {
    property: string;
    valueType: string;
    sample: string | null;
    distinctValues: number;
  }[];
}

interface NameRow {
  id: number;
  raw_name: string;
  canonical: string | null;
  status: EventNameStatus;
  confidence: SuggestionConfidence | null;
  reason: string | null;
  event_count: string;
  distinct_users: number;
  median_sequence_position: string | null;
  first_seen_at: Date;
  last_seen_at: Date;
  owning_source: string | null;
}

const NAME_COLUMNS = `
  id, raw_name, canonical, status, confidence, reason, event_count, distinct_users,
  median_sequence_position, first_seen_at, last_seen_at, owning_source
`;

function toEntry(row: NameRow): Omit<DictionaryEntry, 'properties'> {
  return {
    id: row.id,
    rawName: row.raw_name,
    canonical: row.canonical,
    status: row.status,
    confidence: row.confidence,
    reason: row.reason,
    eventCount: Number(row.event_count),
    distinctUsers: row.distinct_users,
    medianSequencePosition:
      row.median_sequence_position === null ? null : Number(row.median_sequence_position),
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    owningSource: row.owning_source,
  };
}

/** Every name this project has ever sent, most used first. */
export async function dictionary(db: ScopedDb): Promise<DictionaryEntry[]> {
  const rows = await db.query<NameRow>(
    `SELECT ${NAME_COLUMNS} FROM event_names WHERE project_id = $1 ORDER BY event_count DESC, raw_name`,
    [db.projectId],
  );
  return withProperties(db, rows);
}

/**
 * The Inbox: names that count toward nothing yet.
 *
 * `unmapped` has never been looked at; `suggested` has a proposal waiting for the
 * founder. Both are in the Inbox, because neither is counted until confirmed.
 */
export async function inbox(db: ScopedDb): Promise<DictionaryEntry[]> {
  const rows = await db.query<NameRow>(
    `SELECT ${NAME_COLUMNS}
       FROM event_names
      WHERE project_id = $1 AND status IN ('unmapped', 'suggested')
      ORDER BY event_count DESC, raw_name`,
    [db.projectId],
  );
  return withProperties(db, rows);
}

async function withProperties(db: ScopedDb, rows: NameRow[]): Promise<DictionaryEntry[]> {
  if (rows.length === 0) return [];

  const properties = await db.query<{
    name_id: number;
    property: string;
    value_type: string;
    sample: string | null;
    distinct_values: number;
  }>(
    `SELECT name_id, property, value_type, sample, distinct_values
       FROM event_name_properties
      WHERE project_id = $1 AND name_id = ANY($2)
      ORDER BY seen_count DESC, property`,
    [db.projectId, rows.map((r) => r.id)],
  );

  const byName = new Map<number, DictionaryEntry['properties']>();
  for (const row of properties) {
    const list = byName.get(row.name_id) ?? [];
    list.push({
      property: row.property,
      valueType: row.value_type,
      sample: row.sample,
      distinctValues: row.distinct_values,
    });
    byName.set(row.name_id, list);
  }

  return rows.map((row) => ({ ...toEntry(row), properties: byName.get(row.id) ?? [] }));
}

export interface SuggestionToStore {
  rawName: string;
  canonical: string | null;
  confidence: SuggestionConfidence;
  reason: string;
}

/**
 * Stores proposals for the founder to confirm.
 *
 * It only ever touches rows that are still `unmapped`. A name the founder has
 * already confirmed or ignored is their decision, and a later suggestion run must
 * not quietly overwrite it.
 */
export async function storeSuggestions(
  db: ScopedDb,
  suggestions: readonly SuggestionToStore[],
): Promise<number> {
  if (suggestions.length === 0) return 0;

  return db.exec(
    `UPDATE event_names SET
       canonical  = s.canonical,
       confidence = s.confidence,
       reason     = s.reason,
       status     = 'suggested'
     FROM unnest($2::text[], $3::text[], $4::text[], $5::text[])
          AS s(raw_name, canonical, confidence, reason)
     WHERE event_names.project_id = $1
       AND event_names.raw_name = s.raw_name
       AND event_names.status = 'unmapped'`,
    [
      db.projectId,
      suggestions.map((s) => s.rawName),
      suggestions.map((s) => s.canonical),
      suggestions.map((s) => s.confidence),
      suggestions.map((s) => s.reason),
    ],
  );
}

/**
 * The founder confirms a mapping. Returns true when history needs rebuilding.
 *
 * Confirming is the moment a name starts counting, so every number derived from it
 * changes. The caller queues a recompute (brief §7: "Mapping changes recompute
 * history").
 */
export async function confirmMapping(
  db: ScopedDb,
  rawName: string,
  canonical: string | null,
  actorUserId: string | null,
  now: Date,
): Promise<boolean> {
  const before = await db.maybeOne<{ canonical: string | null; status: EventNameStatus }>(
    'SELECT canonical, status FROM event_names WHERE project_id = $1 AND raw_name = $2',
    [db.projectId, rawName],
  );
  if (!before) return false;

  await db.exec(
    `UPDATE event_names
        SET canonical = $3, status = 'confirmed', confirmed_by = $4, confirmed_at = $5
      WHERE project_id = $1 AND raw_name = $2`,
    [db.projectId, rawName, canonical, actorUserId, now],
  );

  await db.exec(
    `INSERT INTO audit_log (project_id, actor_user_id, action, subject, details)
     VALUES ($1, $2, 'mapping.confirmed', $3, $4)`,
    [
      db.projectId,
      actorUserId,
      rawName,
      JSON.stringify({ from: before.canonical, to: canonical, wasStatus: before.status }),
    ],
  );

  // Only a change in what the name MEANS changes any number.
  return before.canonical !== canonical;
}

/** The founder says a name is noise. It stays visible but counts toward nothing. */
export async function ignoreName(
  db: ScopedDb,
  rawName: string,
  actorUserId: string | null,
): Promise<void> {
  await db.exec(
    `UPDATE event_names SET canonical = NULL, status = 'ignored' WHERE project_id = $1 AND raw_name = $2`,
    [db.projectId, rawName],
  );
  await db.exec(
    `INSERT INTO audit_log (project_id, actor_user_id, action, subject)
     VALUES ($1, $2, 'mapping.ignored', $3)`,
    [db.projectId, actorUserId, rawName],
  );
}

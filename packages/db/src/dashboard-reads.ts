import type { ScopedDb } from './scope.js';

/**
 * The two module reads that have no engine behind them (brief §9).
 *
 * The checkout module is two counts and a drop-off; the browser/server share is one
 * group-by. Neither needs a rule, so neither gets one.
 *
 * The share takes `now`, because it reports a window. It read `now()` inside the SQL
 * at first, which is the same hidden clock the funnel's trend had: it cannot be
 * tested over simulated data, which happens in the past, and it answers a question
 * about last August with the last seven days of this month (CLAUDE.md rule 9).
 */

export interface CheckoutSummary {
  /** People who started a checkout that was not a card-up-front trial. */
  started: number;
  /** People who went on to pay. */
  completed: number;
  /** Started and never paid. */
  dropped: number;
  completionRate: number | null;
  /** Open last-moment-drop leaks: the ones still worth chasing. */
  lastMomentDrops: number;
  /** Null until a paid event arrives (settled decision 9). */
  note: string | null;
}

export async function checkoutSummary(db: ScopedDb): Promise<CheckoutSummary> {
  const row = await db.one<{
    started: string;
    completed: string;
    drops: string;
    paid_event: boolean;
  }>(
    `WITH checkouts AS (
       SELECT DISTINCT e.user_key
         FROM events e
         JOIN event_names n ON n.project_id = e.project_id AND n.id = e.name_id
         JOIN end_users u ON u.project_id = e.project_id AND u.user_key = e.user_key
        WHERE e.project_id = $1
          AND n.canonical = 'Checkout Started'
          AND coalesce(lower(e.props->>'type'), 'purchase') <> 'trial'
          AND coalesce(e.props->>'trial', 'false') <> 'true'
          AND u.deleted_at IS NULL AND NOT u.internal
     )
     SELECT
       (SELECT count(*) FROM checkouts)::text AS started,
       (SELECT count(*) FROM checkouts c
          JOIN end_users u ON u.project_id = $1 AND u.user_key = c.user_key
         WHERE u.paid_at IS NOT NULL)::text AS completed,
       (SELECT count(*) FROM leak_instances
         WHERE project_id = $1 AND leak_type = 'last-moment-drop' AND state = 'open')::text AS drops,
       EXISTS (
         SELECT 1 FROM event_names
          WHERE project_id = $1 AND canonical = 'Subscription Started'
            AND status = 'confirmed' AND event_count > 0
       ) AS paid_event`,
    [db.projectId],
  );

  const started = Number(row.started);
  const completed = Number(row.completed);

  return {
    started,
    completed,
    dropped: started - completed,
    completionRate: started === 0 ? null : completed / started,
    lastMomentDrops: Number(row.drops),
    note: row.paid_event
      ? null
      : 'We can see who starts a checkout, but not who finishes one, until a paid event arrives.',
  };
}

export interface SourceShare {
  source: string;
  events: number;
  share: number;
}

/**
 * Where the events come from (brief §9's Tracking health module).
 *
 * The browser/server split is the number that tells a founder whether an ad blocker
 * is quietly eating their funnel: a product whose `Signed Up` arrives only from a
 * browser is losing the people who block scripts, and the share is the first sign.
 */
export async function eventSourceShare(db: ScopedDb, now: Date, days = 7): Promise<SourceShare[]> {
  const rows = await db.query<{ source: string; events: string }>(
    `SELECT source::text AS source, count(*)::text AS events
       FROM events
      WHERE project_id = $1
        AND received_at > $3::timestamptz - make_interval(days => $2)
        AND received_at <= $3::timestamptz
      GROUP BY source
      ORDER BY count(*) DESC`,
    [db.projectId, days, now],
  );

  const total = rows.reduce((sum, row) => sum + Number(row.events), 0);
  return rows.map((row) => ({
    source: sourceName(Number(row.source)),
    events: Number(row.events),
    share: total === 0 ? 0 : Number(row.events) / total,
  }));
}

/** `events.source` is a smallint for space; this is the dictionary (brief §4). */
const SOURCE_NAMES = ['browser', 'server', 'segment', 'rudderstack', 'posthog', 'billing'];

function sourceName(value: number): string {
  return SOURCE_NAMES[value] ?? `source ${value}`;
}

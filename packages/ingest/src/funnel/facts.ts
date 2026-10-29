import type { ScopedDb } from '@dripmetric/db';
import type {
  CohortUserFact,
  FrozenThresholds,
  SegmentDimension,
  SegmentFact,
  StepDefinition,
  StepStateFact,
} from '@dripmetric/engine';

/**
 * The facts the funnel engine is given (brief §8: "Workers load the facts, call the
 * engine and store the result").
 *
 * Every function here is a query and nothing else: no rules, no thresholds, no
 * judgement. That separation is what lets the engine be tested with fixtures and
 * these be tested against a real database.
 */

/** Canonical meanings the funnel depends on. Named, not typed inline (rule 11). */
export const SIGNED_UP = 'Signed Up';
export const ACTIVATED = 'Activated';
export const PAID = 'Subscription Started';

/**
 * Events that mean "they skipped it or it broke", for the "skimmed" rule
 * (brief §8.1: "a step finished faster than its 10th percentile and then skipped or
 * errored"). Taken from the catalog's own names.
 */
export const SKIP_OR_ERROR_EVENTS = [
  'Onboarding Step Skipped',
  'Form Abandoned',
  'Form Error',
  'Error Shown',
  'Rage Click',
  'Dead Click',
] as const;

export async function loadStepDefinitions(db: ScopedDb): Promise<StepDefinition[]> {
  const rows = await db.query<{
    id: number;
    position: number;
    label: string;
    importance: 'key' | 'normal' | 'optional';
    expected_seconds: number | null;
    stall_override_seconds: number | null;
  }>(
    `SELECT s.id, s.position, s.label, s.importance, s.expected_seconds, s.stall_override_seconds
       FROM funnel_steps s
       JOIN funnels f ON f.project_id = s.project_id AND f.id = s.funnel_id AND f.is_active
      WHERE s.project_id = $1
      ORDER BY s.position`,
    [db.projectId],
  );

  return rows.map((row) => ({
    stepId: row.id,
    position: row.position,
    label: row.label,
    importance: row.importance,
    expectedSeconds: row.expected_seconds,
    stallOverrideSeconds: row.stall_override_seconds,
  }));
}

export async function loadStepStates(db: ScopedDb): Promise<StepStateFact[]> {
  const rows = await db.query<{
    user_key: number;
    step_id: number;
    first_entered_at: Date | null;
    first_completed_at: Date | null;
    attempts: number;
    visits: number;
    active_seconds: number;
    last_event_at: Date | null;
  }>(
    `SELECT st.user_key, st.step_id, st.first_entered_at, st.first_completed_at,
            st.attempts, st.visits, st.active_seconds, st.last_event_at
       FROM user_step_state st
       JOIN end_users u ON u.project_id = st.project_id AND u.user_key = st.user_key
      WHERE st.project_id = $1
        AND u.deleted_at IS NULL AND NOT u.internal
      ORDER BY st.user_key, st.step_id`,
    [db.projectId],
  );

  return rows.map((row) => ({
    userKey: row.user_key,
    stepId: row.step_id,
    firstEnteredAt: row.first_entered_at,
    firstCompletedAt: row.first_completed_at,
    attempts: row.attempts,
    visits: row.visits,
    activeSeconds: row.active_seconds,
    lastEventAt: row.last_event_at,
  }));
}

export interface LifecycleFact {
  userKey: number;
  signedUpAt: Date | null;
  activatedAt: Date | null;
  paidAt: Date | null;
}

/**
 * Derives the lifecycle timestamps from the events themselves.
 *
 * `signed_up_at`, `activated_at` and `paid_at` are derived state, so they are
 * rebuilt from raw events rather than written on the hot path (CLAUDE.md rule 10).
 * Earliest-wins, so it is idempotent and order-insensitive, and it stays correct
 * after a deletion removes someone's events.
 *
 * It reads the CANONICAL name, so a founder's own "upgraded_to_pro" counts from the
 * moment they map it — the same mapping that drives everything else.
 */
export async function refreshLifecycle(db: ScopedDb): Promise<number> {
  return db.exec(
    `WITH firsts AS (
       SELECT e.user_key,
              min(e.occurred_at) FILTER (WHERE n.canonical = $2) AS signed_up_at,
              min(e.occurred_at) FILTER (WHERE n.canonical = $3) AS activated_at,
              min(e.occurred_at) FILTER (WHERE n.canonical = $4) AS paid_at
         FROM events e
         JOIN event_names n ON n.project_id = e.project_id AND n.id = e.name_id
        WHERE e.project_id = $1
          AND e.user_key IS NOT NULL
          AND n.canonical IN ($2, $3, $4)
        GROUP BY e.user_key
     )
     UPDATE end_users u
        SET signed_up_at = f.signed_up_at,
            activated_at = f.activated_at,
            paid_at      = f.paid_at
       FROM firsts f
      WHERE u.project_id = $1
        AND u.user_key = f.user_key
        AND (u.signed_up_at IS DISTINCT FROM f.signed_up_at
          OR u.activated_at IS DISTINCT FROM f.activated_at
          OR u.paid_at      IS DISTINCT FROM f.paid_at)`,
    [db.projectId, SIGNED_UP, ACTIVATED, PAID],
  );
}

export async function loadLifecycle(db: ScopedDb): Promise<LifecycleFact[]> {
  const rows = await db.query<{
    user_key: number;
    signed_up_at: Date | null;
    activated_at: Date | null;
    paid_at: Date | null;
  }>(
    `SELECT user_key, signed_up_at, activated_at, paid_at
       FROM end_users
      WHERE project_id = $1 AND deleted_at IS NULL AND NOT internal`,
    [db.projectId],
  );

  return rows.map((row) => ({
    userKey: row.user_key,
    signedUpAt: row.signed_up_at,
    activatedAt: row.activated_at,
    paidAt: row.paid_at,
  }));
}

/**
 * Segment splits per step (brief §8.1).
 *
 * A person is attributed to the session they were FIRST in on that step, not to
 * their latest one, because the question is which context they met the step in.
 * `channel` is the one dimension we have to define: a paid click names its network,
 * then the campaign source, then the referring domain, and "direct" when there was
 * nothing at all.
 */
export async function loadSegmentFacts(db: ScopedDb): Promise<Map<number, SegmentFact[]>> {
  const rows = await db.query<{
    step_id: number;
    dimension: SegmentDimension;
    value: string | null;
    entered: string;
    completed: string;
  }>(
    `WITH attributed AS (
       SELECT DISTINCT ON (uss.user_key, uss.step_id)
              uss.user_key,
              uss.step_id,
              s.device_type,
              s.browser,
              s.os,
              s.country,
              CASE
                WHEN s.paid_click THEN 'paid: ' || coalesce(s.paid_network, 'unknown')
                WHEN s.utm_source IS NOT NULL THEN s.utm_source
                WHEN s.referrer_domain IS NOT NULL THEN s.referrer_domain
                ELSE 'direct'
              END AS channel,
              s.utm_campaign
         FROM user_step_sessions uss
         JOIN sessions s ON s.project_id = uss.project_id AND s.id = uss.session_id
        WHERE uss.project_id = $1
        ORDER BY uss.user_key, uss.step_id, s.started_at
     ), joined AS (
       SELECT a.*, st.first_completed_at IS NOT NULL AS completed
         FROM attributed a
         JOIN user_step_state st
           ON st.project_id = $1 AND st.user_key = a.user_key AND st.step_id = a.step_id
         JOIN end_users u
           ON u.project_id = $1 AND u.user_key = a.user_key
        WHERE u.deleted_at IS NULL AND NOT u.internal
     ), split AS (
       SELECT step_id, 'device' AS dimension, device_type AS value, completed FROM joined
       UNION ALL SELECT step_id, 'browser', browser, completed FROM joined
       UNION ALL SELECT step_id, 'os', os, completed FROM joined
       UNION ALL SELECT step_id, 'country', country, completed FROM joined
       UNION ALL SELECT step_id, 'channel', channel, completed FROM joined
       UNION ALL SELECT step_id, 'campaign', utm_campaign, completed FROM joined
     )
     SELECT step_id, dimension, value,
            count(*)::text AS entered,
            count(*) FILTER (WHERE completed)::text AS completed
       FROM split
      GROUP BY step_id, dimension, value`,
    [db.projectId],
  );

  const byStep = new Map<number, SegmentFact[]>();
  for (const row of rows) {
    const list = byStep.get(row.step_id) ?? [];
    list.push({
      dimension: row.dimension,
      value: row.value,
      entered: Number(row.entered),
      completed: Number(row.completed),
    });
    byStep.set(row.step_id, list);
  }
  return byStep;
}

/**
 * Who skipped or errored right after finishing a step, for the "skimmed" mark.
 *
 * "Right after" is the next thing they did, within the hour. A skip three days later
 * is not evidence that they rushed this step.
 */
export const SKIMMED_WINDOW_SECONDS = 60 * 60;

export async function loadSkippedOrErroredAfter(db: ScopedDb): Promise<Map<number, Set<number>>> {
  const rows = await db.query<{ step_id: number; user_key: number }>(
    `SELECT st.step_id, st.user_key
       FROM user_step_state st
       JOIN events e ON e.project_id = st.project_id AND e.user_key = st.user_key
       JOIN event_names n ON n.project_id = e.project_id AND n.id = e.name_id
      WHERE st.project_id = $1
        AND st.first_completed_at IS NOT NULL
        AND n.canonical = ANY($2)
        AND e.occurred_at >= st.first_completed_at
        AND e.occurred_at < st.first_completed_at + make_interval(secs => $3)
      GROUP BY st.step_id, st.user_key`,
    [db.projectId, [...SKIP_OR_ERROR_EVENTS], SKIMMED_WINDOW_SECONDS],
  );

  const byStep = new Map<number, Set<number>>();
  for (const row of rows) {
    const set = byStep.get(row.step_id) ?? new Set<number>();
    set.add(row.user_key);
    byStep.set(row.step_id, set);
  }
  return byStep;
}

/**
 * The 8-week trend per step (brief §9), read from the daily aggregates.
 *
 * `now` is a parameter rather than `current_date` in the query: a clock read inside
 * SQL is still a clock read, and it would answer a question about a past moment with
 * the last eight weeks of this one (CLAUDE.md rule 9).
 */
export async function loadTrend(
  db: ScopedDb,
  now: Date,
  weeks = 8,
): Promise<Map<number, { weekStart: string; entered: number; completed: number }[]>> {
  const rows = await db.query<{
    step_id: number;
    week_start: string;
    entered: string;
    completed: string;
  }>(
    `SELECT step_id,
            to_char(date_trunc('week', day), 'YYYY-MM-DD') AS week_start,
            sum(entered)::text AS entered,
            sum(completed)::text AS completed
       FROM step_daily
      WHERE project_id = $1
        AND day >= ($3::timestamptz::date - make_interval(weeks => $2))
        AND day <= $3::timestamptz::date
      GROUP BY step_id, date_trunc('week', day)
      ORDER BY step_id, date_trunc('week', day)`,
    [db.projectId, weeks, now],
  );

  const byStep = new Map<number, { weekStart: string; entered: number; completed: number }[]>();
  for (const row of rows) {
    const list = byStep.get(row.step_id) ?? [];
    list.push({
      weekStart: row.week_start,
      entered: Number(row.entered),
      completed: Number(row.completed),
    });
    byStep.set(row.step_id, list);
  }
  return byStep;
}

/** Every day each signed-up person did something, for the retention cohorts. */
export async function loadCohortFacts(db: ScopedDb): Promise<CohortUserFact[]> {
  const rows = await db.query<{ user_key: number; signed_up_at: Date; active_days: string[] }>(
    `SELECT u.user_key,
            u.signed_up_at,
            coalesce(array_agg(DISTINCT to_char(e.occurred_at, 'YYYY-MM-DD'))
                     FILTER (WHERE e.occurred_at IS NOT NULL), '{}') AS active_days
       FROM end_users u
       LEFT JOIN events e ON e.project_id = u.project_id AND e.user_key = u.user_key
      WHERE u.project_id = $1
        AND u.signed_up_at IS NOT NULL
        AND u.deleted_at IS NULL AND NOT u.internal
      GROUP BY u.user_key, u.signed_up_at`,
    [db.projectId],
  );

  return rows.map((row) => ({
    userKey: row.user_key,
    signedUpAt: row.signed_up_at,
    activeDays: row.active_days,
  }));
}

/**
 * The frozen thresholds from the most recent marked change, if any (brief §8.1).
 *
 * The newest change wins: a founder who changes the same step twice is comparing
 * against the bar at their latest change, not their first.
 */
export async function loadFrozenThresholds(db: ScopedDb): Promise<FrozenThresholds | null> {
  const row = await db.maybeOne<{
    id: string;
    happened_at: Date;
    frozen_thresholds: FrozenThresholds['thresholds'];
  }>(
    `SELECT id, happened_at, frozen_thresholds
       FROM changes
      WHERE project_id = $1 AND jsonb_array_length(frozen_thresholds) > 0
      ORDER BY happened_at DESC, id DESC
      LIMIT 1`,
    [db.projectId],
  );
  if (!row) return null;

  return {
    changeId: row.id,
    frozenAt: row.happened_at,
    thresholds: row.frozen_thresholds,
  };
}

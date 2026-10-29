import type { ScopedDb } from '@dripmetric/db';
import { loadPricingReadings } from '../intent/facts.js';
import {
  COLLAPSE_BASELINE_DAYS,
  COLLAPSE_WINDOW_HOURS,
  PAYER_BASELINE_WEEKS,
  PAYER_QUIET_WEEKS,
  type StepCollapseFact,
  type StepLeakFact,
  type UserLeakFacts,
} from '@dripmetric/engine';

/**
 * The facts the leak rules are given (brief §8.3).
 *
 * The rules are pure; this is the only part that knows about rows. Each loader
 * takes `now`, including for every rolling window, so a sweep can be run over a past
 * moment and give the answer it would have given then (CLAUDE.md rule 9).
 */

/** The canonical names the leak rules read. Named, never inline (rule 11). */
export const LEAK_EVENTS = {
  checkoutStarted: 'Checkout Started',
  subscriptionCancelled: 'Subscription Cancelled',
  paymentFailed: 'Payment Failed',
  planLimitReached: 'Plan Limit Reached',
  trialEnded: 'Trial Ended',
} as const;

/**
 * Brief §8.3: "Trial-only checkouts are marked by `type: "trial"` on
 * `Checkout Started` (default `purchase`; accept `trial: true` as an alias). They add
 * no intent points and never count as a last-moment drop."
 *
 * The alias matters: a founder who sends `trial: true` and a founder who sends
 * `type: "trial"` both mean the same thing, and getting it wrong would alert them
 * about every trial signup as a lost sale.
 */
export function isTrialCheckout(props: Record<string, unknown> | null): boolean {
  if (props === null) return false;
  if (typeof props['type'] === 'string' && props['type'].toLowerCase() === 'trial') return true;
  const alias = props['trial'];
  return alias === true || alias === 'true';
}

interface UserRow {
  user_key: number;
  // `quick_exit_at` is deliberately absent: it comes from the pricing classifier.

  paid_at: Date | null;
  deleted_at: Date | null;
  opted_out: boolean;
  last_event_at: Date | null;
  trial_ends_at: Date | null;
  peak_score: number | null;
  first_high_at: Date | null;
  checkout_started_at: Date | null;
  plan_limit_reached_at: Date | null;
  cancelled_at: Date | null;
  cancel_reason: string | null;
  payment_failed_at: Date | null;
  payment_failed_code: string | null;
  recent_week_1: number | null;
  recent_week_2: number | null;
  baseline_active_days: string | null;
}

/**
 * Everything the per-person leaks need, in one query per project.
 *
 * The weekly active-day counts are computed here rather than in the engine because
 * they are a group-by over events; the comparison between them is the rule, and that
 * stays in the engine.
 */
export async function loadUserLeakFacts(db: ScopedDb, now: Date): Promise<UserLeakFacts[]> {
  const rows = await db.query<UserRow>(
    `WITH named AS (
       SELECT e.user_key, e.occurred_at, e.props, n.canonical
         FROM events e
         JOIN event_names n ON n.project_id = e.project_id AND n.id = e.name_id
        WHERE e.project_id = $1 AND e.user_key IS NOT NULL AND n.canonical IS NOT NULL
     ), weekly AS (
       /*
        * Active days per week, counting back from the given moment in whole
        *
        * 7-day windows. Week 1 is the last seven days, week 2 the seven before
        * that, and the
        * baseline is the four weeks before those — "their own 4-week baseline"
        * (brief §8.3), which is why it is per user and not a project average.
        */
       SELECT user_key,
              count(DISTINCT occurred_at::date) FILTER (
                WHERE occurred_at > $2::timestamptz - interval '7 days'
              )::int AS recent_week_1,
              count(DISTINCT occurred_at::date) FILTER (
                WHERE occurred_at > $2::timestamptz - interval '14 days'
                  AND occurred_at <= $2::timestamptz - interval '7 days'
              )::int AS recent_week_2,
              (count(DISTINCT occurred_at::date) FILTER (
                WHERE occurred_at > $2::timestamptz - make_interval(days => 14 + 7 * $3)
                  AND occurred_at <= $2::timestamptz - interval '14 days'
              )::numeric / $3)::text AS baseline_active_days
         FROM named
        GROUP BY user_key
     )
     SELECT u.user_key,
            u.paid_at,
            u.deleted_at,
            u.opted_out,
            u.last_event_at,
            u.trial_ends_at,
            i.peak_score,
            i.first_high_at,
            -- A trial-only checkout never counts (brief §8.3).
            min(e.occurred_at) FILTER (
              WHERE e.canonical = $4
                AND coalesce(lower(e.props->>'type'), 'purchase') <> 'trial'
                AND coalesce(e.props->>'trial', 'false') NOT IN ('true')
            ) AS checkout_started_at,
            min(e.occurred_at) FILTER (WHERE e.canonical = $5) AS plan_limit_reached_at,
            min(e.occurred_at) FILTER (WHERE e.canonical = $6) AS cancelled_at,
            (array_agg(e.props->>'reason' ORDER BY e.occurred_at)
               FILTER (WHERE e.canonical = $6))[1] AS cancel_reason,
            min(e.occurred_at) FILTER (WHERE e.canonical = $7) AS payment_failed_at,
            (array_agg(e.props->>'declineCode' ORDER BY e.occurred_at)
               FILTER (WHERE e.canonical = $7))[1] AS payment_failed_code,
            w.recent_week_1,
            w.recent_week_2,
            w.baseline_active_days
       FROM end_users u
       LEFT JOIN named e ON e.user_key = u.user_key
       LEFT JOIN intent_state i ON i.project_id = $1 AND i.user_key = u.user_key
       LEFT JOIN weekly w ON w.user_key = u.user_key
      WHERE u.project_id = $1 AND NOT u.internal
      GROUP BY u.user_key, u.paid_at, u.deleted_at, u.opted_out, u.last_event_at,
               u.trial_ends_at, i.peak_score, i.first_high_at,
               w.recent_week_1, w.recent_week_2, w.baseline_active_days`,
    [
      db.projectId,
      now,
      PAYER_BASELINE_WEEKS,
      LEAK_EVENTS.checkoutStarted,
      LEAK_EVENTS.planLimitReached,
      LEAK_EVENTS.subscriptionCancelled,
      LEAK_EVENTS.paymentFailed,
    ],
  );

  const steps = await loadStepLeakFacts(db);

  /*
   * The quick exits come from the pricing classifier, not from `leak_instances`.
   *
   * Reading them back from the table they are written to was circular: the leak could
   * never fire a first time, and the simulator reported 0 quick exits out of 167
   * first-ever pricing views. The classifier is the single definition, shared with
   * the intent engine, which needs the same readings for its own two signals.
   */
  const quickExits = new Map<number, Date>();
  for (const reading of await loadPricingReadings(db)) {
    if (!reading.countsAsLeak || reading.userKey === null) continue;
    const existing = quickExits.get(reading.userKey);
    if (existing === undefined || reading.at < existing)
      quickExits.set(reading.userKey, reading.at);
  }

  return rows.map((row) => ({
    userKey: row.user_key,
    paidAt: row.paid_at,
    deletedAt: row.deleted_at,
    optedOut: row.opted_out,
    lastEventAt: row.last_event_at,
    peakScore: row.peak_score ?? 0,
    firstHighAt: row.first_high_at,
    trialEndsAt: row.trial_ends_at,
    checkoutStartedAt: row.checkout_started_at,
    planLimitReachedAt: row.plan_limit_reached_at,
    cancelledAt: row.cancelled_at,
    cancelReason: row.cancel_reason,
    paymentFailedAt: row.payment_failed_at,
    paymentFailedCode: row.payment_failed_code,
    steps: steps.get(row.user_key) ?? [],
    pricingQuickExitAt: quickExits.get(row.user_key) ?? null,
    recentWeeklyActiveDays:
      row.recent_week_1 === null || row.recent_week_2 === null
        ? null
        : [row.recent_week_1, row.recent_week_2],
    baselineActiveDaysPerWeek:
      row.baseline_active_days === null ? null : Number(row.baseline_active_days),
  }));
}

/**
 * The unfinished steps, with the bar each one allows.
 *
 * `stall_elapsed_seconds` is M6's stored threshold: the founder's override, else the
 * step's own 90th percentile clamped to 1–72 hours, else the 24-hour default. The
 * stall is "adaptive" because that number is — the rule itself is one comparison.
 */
async function loadStepLeakFacts(db: ScopedDb): Promise<Map<number, StepLeakFact[]>> {
  const rows = await db.query<{
    user_key: number;
    step_id: number;
    label: string;
    importance: 'key' | 'normal' | 'optional';
    first_entered_at: Date | null;
    first_completed_at: Date | null;
    last_event_at: Date | null;
    stall_seconds: string | null;
    completions: number | null;
  }>(
    `SELECT st.user_key, st.step_id, s.label, s.importance,
            st.first_entered_at, st.first_completed_at, st.last_event_at,
            t.stuck_elapsed_seconds::text AS stall_seconds,
            t.completions
       FROM user_step_state st
       JOIN funnel_steps s ON s.project_id = st.project_id AND s.id = st.step_id
       JOIN funnels f ON f.project_id = s.project_id AND f.id = s.funnel_id AND f.is_active
       LEFT JOIN step_thresholds t ON t.project_id = st.project_id AND t.step_id = st.step_id
      WHERE st.project_id = $1 AND st.first_completed_at IS NULL
      ORDER BY st.user_key, s.position`,
    [db.projectId],
  );

  const byUser = new Map<number, StepLeakFact[]>();
  for (const row of rows) {
    const list = byUser.get(row.user_key) ?? [];
    list.push({
      stepId: row.step_id,
      label: row.label,
      importance: row.importance,
      enteredAt: row.first_entered_at,
      completedAt: row.first_completed_at,
      lastEventAt: row.last_event_at,
      // Settled decision 8's 24-hour default, when M6's job has not run yet.
      stallSeconds: row.stall_seconds === null ? 24 * 3_600 : Number(row.stall_seconds),
      completions: row.completions ?? 0,
    });
    byUser.set(row.user_key, list);
  }
  return byUser;
}

/**
 * Each step's last 24 hours against its trailing 14-day rate (brief §8.3).
 *
 * Read from `step_daily`, which M6's nightly job writes, plus the current day's
 * completions from the step state — so the hourly collapse test sees today without
 * waiting for tonight.
 */
export async function loadCollapseFacts(db: ScopedDb, now: Date): Promise<StepCollapseFact[]> {
  return (
    await db.query<{
      step_id: number;
      label: string;
      observed: string;
      baseline: string;
    }>(
      `SELECT s.id AS step_id,
              s.label,
              count(*) FILTER (
                WHERE st.first_completed_at > $2::timestamptz - make_interval(hours => $3)
              )::text AS observed,
              count(*) FILTER (
                WHERE st.first_completed_at > $2::timestamptz - make_interval(days => $4)
                  AND st.first_completed_at <= $2::timestamptz - make_interval(hours => $3)
              )::text AS baseline
         FROM funnel_steps s
         JOIN funnels f ON f.project_id = s.project_id AND f.id = s.funnel_id AND f.is_active
         LEFT JOIN user_step_state st
           ON st.project_id = s.project_id AND st.step_id = s.id
         LEFT JOIN end_users u
           ON u.project_id = s.project_id AND u.user_key = st.user_key
          AND u.deleted_at IS NULL AND NOT u.internal
        WHERE s.project_id = $1
        GROUP BY s.id, s.label, s.position
        ORDER BY s.position`,
      [db.projectId, now, COLLAPSE_WINDOW_HOURS, COLLAPSE_BASELINE_DAYS],
    )
  ).map((row) => ({
    stepId: row.step_id,
    label: row.label,
    observed: Number(row.observed),
    baselineCompletions: Number(row.baseline),
  }));
}

/** What data the project has, so the unavailable leaks can say why (brief §8.3). */
export async function leakAvailability(
  db: ScopedDb,
): Promise<{ paidEvent: boolean; trialDates: boolean; price: boolean }> {
  const row = await db.one<{ paid: boolean; trials: boolean; price: boolean }>(
    `SELECT
       EXISTS (
         SELECT 1 FROM event_names
          WHERE project_id = $1 AND canonical = 'Subscription Started'
            AND status = 'confirmed' AND event_count > 0
       ) AS paid,
       EXISTS (
         SELECT 1 FROM end_users
          WHERE project_id = $1 AND trial_ends_at IS NOT NULL
       ) AS trials,
       EXISTS (
         SELECT 1 FROM projects
          WHERE id = $1 AND (settings->>'listPriceAmount') IS NOT NULL
       ) AS price`,
    [db.projectId],
  );
  return { paidEvent: row.paid, trialDates: row.trials, price: row.price };
}

export { PAYER_QUIET_WEEKS };

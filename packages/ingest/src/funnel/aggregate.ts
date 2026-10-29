import { withProject, type ScopedDb } from '@dripmetric/db';
import {
  applyFreeze,
  funnelReport,
  MIN_COMPLETIONS_FOR_PERCENTILES,
  retentionCohorts,
  thresholdsFor,
  timeToValue,
  timingsForUser,
  type FunnelReport,
  type StepFacts,
  type StepThresholds,
  type StepTiming,
} from '@dripmetric/engine';
import {
  loadCohortFacts,
  loadFrozenThresholds,
  loadLifecycle,
  loadSegmentFacts,
  loadSkippedOrErroredAfter,
  loadStepDefinitions,
  loadStepStates,
  loadTrend,
  refreshLifecycle,
} from './facts.js';

/**
 * The funnel jobs (brief §11, M6: "worker jobs, hourly and daily aggregates, segment
 * splits, retention cohorts").
 *
 * Each one loads facts, calls the pure engine and stores the result. `now` is always
 * a parameter, so a job can be run over a past moment and give the same answer it
 * would have given then (CLAUDE.md rules 9 and 10).
 */

/** Assembles everything the engine needs for one project, in one place. */
export async function funnelFactsFor(
  db: ScopedDb,
  now: Date,
): Promise<{ facts: Parameters<typeof funnelReport>[0]; timings: Map<number, StepTiming[]> }> {
  const steps = await loadStepDefinitions(db);
  const states = await loadStepStates(db);
  const lifecycle = await loadLifecycle(db);
  const segments = await loadSegmentFacts(db);
  const skipped = await loadSkippedOrErroredAfter(db);
  const trend = await loadTrend(db, now);
  const frozen = await loadFrozenThresholds(db);

  // Per person, then grouped per step: the engine's timing rules need a whole
  // person at a time (the gap to the next step), and its step rules need a whole
  // step at a time (the percentiles).
  const byUser = new Map<number, typeof states>();
  for (const state of states) {
    const list = byUser.get(state.userKey) ?? [];
    list.push(state);
    byUser.set(state.userKey, list);
  }

  const timingsByStep = new Map<number, StepTiming[]>();
  const timingsByUser = new Map<number, StepTiming[]>();

  for (const [userKey, userStates] of byUser) {
    const timings = timingsForUser(userStates, steps, now).map((timing) => ({
      ...timing,
      userKey,
    }));
    timingsByUser.set(userKey, timings);

    for (const timing of timings) {
      // Someone who never reached a step is not in that step's population — but
      // reaching it includes finishing it without an entry event of our own.
      if (!timing.reached) continue;
      const list = timingsByStep.get(timing.stepId) ?? [];
      list.push(timing);
      timingsByStep.set(timing.stepId, list);
    }
  }

  const computed: StepThresholds[] = steps.map((step) =>
    thresholdsFor(step, timingsByStep.get(step.stepId) ?? [], now),
  );
  const thresholds = new Map(applyFreeze(computed, frozen).map((entry) => [entry.stepId, entry]));

  const stepFacts: StepFacts[] = steps.map((step) => ({
    step,
    timings: timingsByStep.get(step.stepId) ?? [],
    thresholds: thresholds.get(step.stepId)!,
    segments: segments.get(step.stepId) ?? [],
    trend: trend.get(step.stepId) ?? [],
    skippedOrErroredAfter: skipped.get(step.stepId) ?? new Set<number>(),
  }));

  const byKey = new Map(lifecycle.map((entry) => [entry.userKey, entry]));

  return {
    facts: {
      steps: stepFacts,
      signedUp: lifecycle.filter((entry) => entry.signedUpAt !== null).length,
      activated: lifecycle.filter((entry) => entry.activatedAt !== null).length,
      paid: lifecycle.filter((entry) => entry.paidAt !== null).length,
      timeToValue: [...timingsByUser.entries()].map(([userKey, timings]) =>
        timeToValue(
          byKey.get(userKey)?.signedUpAt ?? null,
          byKey.get(userKey)?.activatedAt ?? null,
          timings,
        ),
      ),
    },
    timings: timingsByStep,
  };
}

/**
 * The report the dashboard reads (brief §9's Funnel module).
 *
 * Computed from current state rather than from a stored row, because "users stuck
 * now" is a present tense: a stored count would be as old as the last job. The read
 * is bounded by the plan's tracked-user limit, and the dashboard caches it for 60
 * seconds (brief §9).
 */
export async function currentFunnelReport(db: ScopedDb, now: Date): Promise<FunnelReport> {
  const { facts } = await funnelFactsFor(db, now);
  return funnelReport(facts, now);
}

/** Stores the thresholds in force, so every screen judges a step the same way. */
export async function storeThresholds(db: ScopedDb, now: Date): Promise<number> {
  const { facts } = await funnelFactsFor(db, now);
  const rows = facts.steps.map((step) => step.thresholds);
  if (rows.length === 0) return 0;

  await db.exec(
    `INSERT INTO step_thresholds (
       project_id, step_id, completions, rushed_seconds, stuck_active_seconds,
       stuck_elapsed_seconds, cooling_gap_seconds, computed_at, frozen_by_change_id
     )
     SELECT $1, t.step_id, t.completions, t.rushed, t.stuck_active,
            t.stuck_elapsed, t.cooling_gap, t.computed_at, t.frozen_by
       FROM unnest($2::int[], $3::int[], $4::numeric[], $5::numeric[], $6::numeric[],
                   $7::numeric[], $8::timestamptz[], $9::bigint[])
            AS t(step_id, completions, rushed, stuck_active, stuck_elapsed,
                 cooling_gap, computed_at, frozen_by)
     ON CONFLICT (project_id, step_id) DO UPDATE SET
       completions           = EXCLUDED.completions,
       rushed_seconds        = EXCLUDED.rushed_seconds,
       stuck_active_seconds  = EXCLUDED.stuck_active_seconds,
       stuck_elapsed_seconds = EXCLUDED.stuck_elapsed_seconds,
       cooling_gap_seconds   = EXCLUDED.cooling_gap_seconds,
       computed_at           = EXCLUDED.computed_at,
       frozen_by_change_id   = EXCLUDED.frozen_by_change_id`,
    [
      db.projectId,
      rows.map((r) => r.stepId),
      rows.map((r) => r.completions),
      rows.map((r) => r.rushedSeconds),
      rows.map((r) => r.stuckActiveSeconds),
      rows.map((r) => r.stuckElapsedSeconds),
      rows.map((r) => r.coolingGapSeconds),
      rows.map((r) => r.computedAt),
      rows.map((r) => r.frozenByChangeId),
    ],
  );
  return rows.length;
}

/**
 * The hourly aggregate (brief §11, M6).
 *
 * A person is counted on the hour they ENTERED a step and again on the hour they
 * COMPLETED it, which are usually different hours. Recomputed over a window rather
 * than incremented, so running it twice changes nothing.
 */
export async function aggregateHours(db: ScopedDb, now: Date, hours = 48): Promise<number> {
  const from = new Date(now.getTime() - hours * 3_600_000);

  return db.exec(
    `WITH entered AS (
       -- A step defined by a server event is reached at its completion: there is no
       -- entry event of its own, so coalesce to the completion time.
       SELECT step_id,
              date_trunc('hour', coalesce(first_entered_at, first_completed_at)) AS hour,
              count(*)::int AS n
         FROM user_step_state st
         JOIN end_users u ON u.project_id = st.project_id AND u.user_key = st.user_key
        WHERE st.project_id = $1
          AND coalesce(st.first_entered_at, st.first_completed_at) >= $2
          AND u.deleted_at IS NULL AND NOT u.internal
        GROUP BY 1, 2
     ), completed AS (
       SELECT step_id, date_trunc('hour', first_completed_at) AS hour, count(*)::int AS n
         FROM user_step_state st
         JOIN end_users u ON u.project_id = st.project_id AND u.user_key = st.user_key
        WHERE st.project_id = $1 AND st.first_completed_at >= $2
          AND u.deleted_at IS NULL AND NOT u.internal
        GROUP BY 1, 2
     ), merged AS (
       SELECT coalesce(e.step_id, c.step_id) AS step_id,
              coalesce(e.hour, c.hour) AS hour,
              coalesce(e.n, 0) AS entered,
              coalesce(c.n, 0) AS completed
         FROM entered e
         FULL OUTER JOIN completed c ON c.step_id = e.step_id AND c.hour = e.hour
     )
     INSERT INTO step_hourly (project_id, step_id, hour, entered, completed)
     SELECT $1, step_id, hour, entered, completed FROM merged
     ON CONFLICT (project_id, step_id, hour) DO UPDATE SET
       entered = EXCLUDED.entered,
       completed = EXCLUDED.completed`,
    [db.projectId, from],
  );
}

/**
 * The daily aggregate, including the elapsed-time distribution per day.
 *
 * The percentiles are computed in SQL with `percentile_cont`, which is the same
 * definition the engine's `percentile()` uses — deliberately, so a number computed
 * here and the same number computed there cannot disagree.
 *
 * They are only written once the day has 20 completions, exactly as the engine
 * withholds them (brief §8.1), so a stored row can never hand a screen a median the
 * engine would have refused to show.
 */
export async function aggregateDays(db: ScopedDb, now: Date, days = 14): Promise<number> {
  const from = new Date(now.getTime() - days * 86_400_000);

  return db.exec(
    `WITH people AS (
       SELECT st.*
         FROM user_step_state st
         JOIN end_users u ON u.project_id = st.project_id AND u.user_key = st.user_key
        WHERE st.project_id = $1 AND u.deleted_at IS NULL AND NOT u.internal
     ), entered AS (
       -- A step defined by a server event has no entry of its own, so the completion
       -- is when they reached it.
       SELECT step_id, coalesce(first_entered_at, first_completed_at)::date AS day,
              count(*)::int AS n
         FROM people
        WHERE coalesce(first_entered_at, first_completed_at) >= $2
        GROUP BY 1, 2
     ), completed AS (
       SELECT step_id,
              first_completed_at::date AS day,
              count(*)::int AS n,
              avg(extract(epoch FROM first_completed_at - first_entered_at)) AS avg_seconds,
              percentile_cont(0.1) WITHIN GROUP (
                ORDER BY extract(epoch FROM first_completed_at - first_entered_at)) AS p10,
              percentile_cont(0.25) WITHIN GROUP (
                ORDER BY extract(epoch FROM first_completed_at - first_entered_at)) AS p25,
              percentile_cont(0.5) WITHIN GROUP (
                ORDER BY extract(epoch FROM first_completed_at - first_entered_at)) AS p50,
              percentile_cont(0.75) WITHIN GROUP (
                ORDER BY extract(epoch FROM first_completed_at - first_entered_at)) AS p75,
              percentile_cont(0.9) WITHIN GROUP (
                ORDER BY extract(epoch FROM first_completed_at - first_entered_at)) AS p90
         FROM people
        WHERE first_completed_at >= $2 AND first_entered_at IS NOT NULL
        GROUP BY 1, 2
     ), stuck AS (
       -- How many were still unfinished when the day ended: "stuck now", as of then.
       SELECT step_id, day, count(*)::int AS n
         FROM people
         CROSS JOIN generate_series($2::date, $3::date, interval '1 day') AS d(day)
        WHERE coalesce(first_entered_at, first_completed_at)::date <= d.day
          AND (first_completed_at IS NULL OR first_completed_at::date > d.day)
        GROUP BY 1, 2
     ), merged AS (
       SELECT coalesce(e.step_id, c.step_id, s.step_id) AS step_id,
              coalesce(e.day, c.day, s.day)::date AS day,
              coalesce(e.n, 0) AS entered,
              coalesce(c.n, 0) AS completed,
              coalesce(s.n, 0) AS stuck_at_end,
              c.avg_seconds, c.p10, c.p25, c.p50, c.p75, c.p90
         FROM entered e
         FULL OUTER JOIN completed c ON c.step_id = e.step_id AND c.day = e.day
         FULL OUTER JOIN stuck s
           ON s.step_id = coalesce(e.step_id, c.step_id) AND s.day = coalesce(e.day, c.day)
     )
     INSERT INTO step_daily (
       project_id, step_id, day, entered, completed, stuck_at_end, completions,
       avg_seconds, p10_seconds, p25_seconds, p50_seconds, p75_seconds, p90_seconds
     )
     SELECT $1, step_id, day, entered, completed, stuck_at_end, completed,
            avg_seconds,
            -- Brief §8.1: no percentile until 20 completions. The same bar as the
            -- engine's, so a stored row can never show what the engine would hide.
            CASE WHEN completed >= $4 THEN p10 END,
            CASE WHEN completed >= $4 THEN p25 END,
            CASE WHEN completed >= $4 THEN p50 END,
            CASE WHEN completed >= $4 THEN p75 END,
            CASE WHEN completed >= $4 THEN p90 END
       FROM merged
      WHERE step_id IS NOT NULL AND day IS NOT NULL
     ON CONFLICT (project_id, step_id, day) DO UPDATE SET
       entered      = EXCLUDED.entered,
       completed    = EXCLUDED.completed,
       stuck_at_end = EXCLUDED.stuck_at_end,
       completions  = EXCLUDED.completions,
       avg_seconds  = EXCLUDED.avg_seconds,
       p10_seconds  = EXCLUDED.p10_seconds,
       p25_seconds  = EXCLUDED.p25_seconds,
       p50_seconds  = EXCLUDED.p50_seconds,
       p75_seconds  = EXCLUDED.p75_seconds,
       p90_seconds  = EXCLUDED.p90_seconds`,
    /*
     * The 20-completion bar is passed in rather than written into the SQL, so the
     * engine's `MIN_COMPLETIONS_FOR_PERCENTILES` is the single definition and the
     * stored rows cannot drift from what the engine would show.
     */
    [db.projectId, from, now, MIN_COMPLETIONS_FOR_PERCENTILES],
  );
}

/** Segment splits per step and day (brief §8.1). */
export async function aggregateSegments(db: ScopedDb, now: Date): Promise<number> {
  const day = now.toISOString().slice(0, 10);
  const segments = await loadSegmentFacts(db);

  const stepIds: number[] = [];
  const dimensions: string[] = [];
  const values: (string | null)[] = [];
  const entered: number[] = [];
  const completed: number[] = [];

  for (const [stepId, facts] of segments) {
    for (const fact of facts) {
      stepIds.push(stepId);
      dimensions.push(fact.dimension);
      values.push(fact.value);
      entered.push(fact.entered);
      completed.push(fact.completed);
    }
  }
  if (stepIds.length === 0) return 0;

  return db.exec(
    `INSERT INTO step_segment_daily (project_id, step_id, day, dimension, value, entered, completed)
     SELECT $1, s.step_id, $2::date, s.dimension, s.value, s.entered, s.completed
       FROM unnest($3::int[], $4::text[], $5::text[], $6::int[], $7::int[])
            AS s(step_id, dimension, value, entered, completed)
     ON CONFLICT (project_id, step_id, day, dimension, value_key) DO UPDATE SET
       entered = EXCLUDED.entered,
       completed = EXCLUDED.completed`,
    [db.projectId, day, stepIds, dimensions, values, entered, completed],
  );
}

/** Week-1 and week-4 retention by signup week (brief §9's Retention module). */
export async function aggregateCohorts(db: ScopedDb, now: Date): Promise<number> {
  const cohorts = retentionCohorts(await loadCohortFacts(db), now);
  if (cohorts.length === 0) return 0;

  await db.exec(
    `INSERT INTO retention_cohorts (
       project_id, cohort_week, users, retained, week1_rate, week4_rate,
       complete_weeks, computed_at
     )
     SELECT $1, c.cohort_week::date, c.users, c.retained, c.week1, c.week4,
            c.complete_weeks, $2
       FROM unnest($3::text[], $4::int[], $5::jsonb[], $6::numeric[], $7::numeric[], $8::int[])
            AS c(cohort_week, users, retained, week1, week4, complete_weeks)
     ON CONFLICT (project_id, cohort_week) DO UPDATE SET
       users          = EXCLUDED.users,
       retained       = EXCLUDED.retained,
       week1_rate     = EXCLUDED.week1_rate,
       week4_rate     = EXCLUDED.week4_rate,
       complete_weeks = EXCLUDED.complete_weeks,
       computed_at    = EXCLUDED.computed_at`,
    [
      db.projectId,
      now,
      cohorts.map((c) => c.cohortWeek),
      cohorts.map((c) => c.users),
      cohorts.map((c) => JSON.stringify(c.retained)),
      cohorts.map((c) => c.week1Rate),
      cohorts.map((c) => c.week4Rate),
      cohorts.map((c) => c.completeWeeks),
    ],
  );
  return cohorts.length;
}

/**
 * The daily summary (brief §4: "kept forever, about 1 MB per project per year").
 *
 * This is the row that outlives the raw events: free keeps 90 days of events, and
 * after that this is all there is. M7 and M8 add their own sections to the same
 * payload, which is why it is one JSONB document rather than a column per number.
 */
export async function writeDailySummary(db: ScopedDb, now: Date): Promise<void> {
  const report = await currentFunnelReport(db, now);
  const day = now.toISOString().slice(0, 10);

  const payload = {
    funnel: {
      signedUp: report.signedUp,
      activated: report.activated,
      paid: report.paid,
      highlightedStepId: report.highlightedStepId,
      timeToValue: report.timeToValue,
      steps: report.steps.map((step) => ({
        stepId: step.stepId,
        label: step.label,
        position: step.position,
        importance: step.importance,
        entered: step.entered,
        completed: step.completed,
        droppedOff: step.droppedOff,
        dropOffRate: step.dropOffRate,
        stuckNow: step.stuckNow,
        flagCounts: step.flagCounts,
        elapsed: step.elapsed,
        highlight: { reason: step.highlight.reason, says: step.highlight.says },
        segmentWarnings: step.segmentWarnings.map((warning) => warning.says),
      })),
    },
  };

  await db.exec(
    `INSERT INTO daily_summaries (project_id, day, payload, computed_at)
     VALUES ($1, $2::date, $3::jsonb, $4)
     ON CONFLICT (project_id, day) DO UPDATE SET
       -- Merged, not replaced: M7 and M8 write their own sections of the same day.
       payload = daily_summaries.payload || EXCLUDED.payload,
       computed_at = EXCLUDED.computed_at`,
    [db.projectId, day, JSON.stringify(payload), now],
  );
}

/** Everything the hourly job does, for one project. */
export async function runFunnelHourly(projectId: number, now: Date): Promise<void> {
  await withProject(
    projectId,
    async (db) => {
      await refreshLifecycle(db);
      await aggregateHours(db, now);
      await storeThresholds(db, now);
    },
    { worker: true },
  );
}

/** Everything the nightly job does, for one project. */
export async function runFunnelDaily(projectId: number, now: Date): Promise<void> {
  await withProject(
    projectId,
    async (db) => {
      await refreshLifecycle(db);
      await aggregateDays(db, now);
      await aggregateSegments(db, now);
      await aggregateCohorts(db, now);
      await storeThresholds(db, now);
      await writeDailySummary(db, now);
    },
    { worker: true },
  );
}

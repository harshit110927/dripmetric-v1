import type { ScopedDb } from './scope.js';

/**
 * The stored funnel results, read back (brief §11, M6: "the API the dashboard reads").
 *
 * The live report is computed by `currentFunnelReport` in `@dripmetric/ingest`,
 * because "stuck now" is a present tense and a stored count would be as old as the
 * last job. These are the parts that are genuinely historical — the trend, the
 * cohorts, and the summaries that outlive the raw events — and they are plain reads.
 */

export interface RetentionRow {
  cohortWeek: string;
  users: number;
  retained: Record<string, number>;
  /** Null while the week has not fully passed for this cohort. */
  week1Rate: number | null;
  week4Rate: number | null;
  completeWeeks: number;
}

export async function retentionCohortRows(db: ScopedDb, weeks = 12): Promise<RetentionRow[]> {
  const rows = await db.query<{
    cohort_week: string;
    users: number;
    retained: Record<string, number>;
    week1_rate: string | null;
    week4_rate: string | null;
    complete_weeks: number;
  }>(
    `SELECT to_char(cohort_week, 'YYYY-MM-DD') AS cohort_week, users, retained,
            week1_rate, week4_rate, complete_weeks
       FROM retention_cohorts
      WHERE project_id = $1
      ORDER BY cohort_week DESC
      LIMIT $2`,
    [db.projectId, weeks],
  );

  return rows.map((row) => ({
    cohortWeek: row.cohort_week,
    users: row.users,
    retained: row.retained,
    week1Rate: row.week1_rate === null ? null : Number(row.week1_rate),
    week4Rate: row.week4_rate === null ? null : Number(row.week4_rate),
    completeWeeks: row.complete_weeks,
  }));
}

export interface RetentionHeadline {
  /** The most recent cohort whose week 1 has fully passed. */
  week1: { cohortWeek: string; rate: number; users: number } | null;
  /** The most recent cohort whose week 4 has fully passed. */
  week4: { cohortWeek: string; rate: number; users: number } | null;
}

/**
 * The two numbers the free level shows (brief §9's Retention module).
 *
 * Each comes from the most recent cohort that has actually finished that week, which
 * are usually two different cohorts — and saying which is part of being able to show
 * how a number was computed.
 */
export async function retentionHeadline(db: ScopedDb): Promise<RetentionHeadline> {
  const rows = await retentionCohortRows(db, 52);
  const week1 = rows.find((row) => row.week1Rate !== null);
  const week4 = rows.find((row) => row.week4Rate !== null);

  return {
    week1: week1
      ? { cohortWeek: week1.cohortWeek, rate: week1.week1Rate!, users: week1.users }
      : null,
    week4: week4
      ? { cohortWeek: week4.cohortWeek, rate: week4.week4Rate!, users: week4.users }
      : null,
  };
}

export interface DailySummaryRow {
  day: string;
  payload: Record<string, unknown>;
  computedAt: Date;
}

/** The summaries, newest first. These survive the retention delete (brief §4). */
export async function dailySummaryRows(db: ScopedDb, days = 30): Promise<DailySummaryRow[]> {
  const rows = await db.query<{ day: string; payload: Record<string, unknown>; computed_at: Date }>(
    `SELECT to_char(day, 'YYYY-MM-DD') AS day, payload, computed_at
       FROM daily_summaries
      WHERE project_id = $1
      ORDER BY day DESC
      LIMIT $2`,
    [db.projectId, days],
  );
  return rows.map((row) => ({ day: row.day, payload: row.payload, computedAt: row.computed_at }));
}

export interface StepTrendRow {
  stepId: number;
  weekStart: string;
  entered: number;
  completed: number;
  completionRate: number | null;
}

/**
 * The 8-week trend per step (brief §9's Funnel module), from the daily aggregates.
 *
 * `now` is a parameter, not `current_date` inside the query. A hidden clock read in
 * SQL is still a hidden clock read (CLAUDE.md rule 9): it made the trend impossible
 * to test over simulated data, which happens months in the past, and it would have
 * answered a question about last August with eight weeks of this month.
 */
export async function stepTrendRows(db: ScopedDb, now: Date, weeks = 8): Promise<StepTrendRow[]> {
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

  return rows.map((row) => {
    const entered = Number(row.entered);
    const completed = Number(row.completed);
    return {
      stepId: row.step_id,
      weekStart: row.week_start,
      entered,
      completed,
      completionRate: entered > 0 ? completed / entered : null,
    };
  });
}

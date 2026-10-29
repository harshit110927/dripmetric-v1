import type { ScopedDb } from './scope.js';

/**
 * Founder-marked changes (brief §4's `changes` table, brief §9's Changes module).
 *
 * "Thresholds freeze when the founder marks a change, so a before-and-after
 * comparison is not measured against a moving bar" (brief §8.1).
 *
 * Marking a change copies the thresholds in force into the change itself. That copy
 * is the bar the "after" is measured against, and because it lives on the change
 * rather than on the step, the step's own thresholds can go on moving without
 * rewriting history.
 */

export interface MarkChangeInput {
  /** Null means the whole funnel: a pricing change, a new landing page. */
  stepId: number | null;
  /** When the change went live, not when they told us. */
  happenedAt: Date;
  note: string;
}

export interface MarkedChange {
  id: string;
  stepId: number | null;
  happenedAt: Date;
  note: string;
  /** How many steps' thresholds were frozen with it. */
  frozenSteps: number;
}

interface ThresholdRow {
  step_id: number;
  completions: number;
  rushed_seconds: string | null;
  stuck_active_seconds: string | null;
  stuck_elapsed_seconds: string;
  cooling_gap_seconds: string | null;
}

export async function markChange(
  db: ScopedDb,
  input: MarkChangeInput,
  actorUserId: string | null,
): Promise<MarkedChange> {
  /*
   * Every step's thresholds are frozen, not only the changed step's.
   *
   * A founder who shortens step 2 wants to know what it did to the whole funnel, and
   * the steps after it are where the answer shows up. Freezing one step would make
   * every other step's "after" be measured against a bar that moved underneath it.
   */
  const rows = await db.query<ThresholdRow>(
    `SELECT step_id, completions, rushed_seconds, stuck_active_seconds,
            stuck_elapsed_seconds, cooling_gap_seconds
       FROM step_thresholds
      WHERE project_id = $1
      ORDER BY step_id`,
    [db.projectId],
  );

  const frozen = rows.map((row) => ({
    stepId: row.step_id,
    completions: row.completions,
    rushedSeconds: numberOrNull(row.rushed_seconds),
    stuckActiveSeconds: numberOrNull(row.stuck_active_seconds),
    stuckElapsedSeconds: Number(row.stuck_elapsed_seconds),
    coolingGapSeconds: numberOrNull(row.cooling_gap_seconds),
  }));

  const change = await db.one<{ id: string }>(
    `INSERT INTO changes (project_id, step_id, happened_at, note, frozen_thresholds, created_by)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)
     RETURNING id`,
    [
      db.projectId,
      input.stepId,
      input.happenedAt,
      input.note.slice(0, 2_000),
      JSON.stringify(frozen),
      actorUserId,
    ],
  );

  // The steps now point at the change that froze them, so a screen can say which.
  await db.exec(`UPDATE step_thresholds SET frozen_by_change_id = $2 WHERE project_id = $1`, [
    db.projectId,
    change.id,
  ]);

  await db.exec(
    `INSERT INTO audit_log (project_id, actor_user_id, action, subject, details)
     VALUES ($1, $2, 'change.marked', $3, $4)`,
    [
      db.projectId,
      actorUserId,
      input.stepId === null ? 'funnel' : `step:${input.stepId}`,
      JSON.stringify({
        note: input.note,
        happenedAt: input.happenedAt,
        frozenSteps: frozen.length,
      }),
    ],
  );

  return {
    id: change.id,
    stepId: input.stepId,
    happenedAt: input.happenedAt,
    note: input.note,
    frozenSteps: frozen.length,
  };
}

export interface ChangeRecord {
  id: string;
  stepId: number | null;
  happenedAt: Date;
  note: string;
  frozenSteps: number;
  result: unknown;
  createdAt: Date;
}

export async function listChanges(db: ScopedDb): Promise<ChangeRecord[]> {
  const rows = await db.query<{
    id: string;
    step_id: number | null;
    happened_at: Date;
    note: string;
    frozen_count: number;
    result: unknown;
    created_at: Date;
  }>(
    `SELECT id, step_id, happened_at, note,
            jsonb_array_length(frozen_thresholds) AS frozen_count, result, created_at
       FROM changes
      WHERE project_id = $1
      ORDER BY happened_at DESC, id DESC`,
    [db.projectId],
  );

  return rows.map((row) => ({
    id: row.id,
    stepId: row.step_id,
    happenedAt: row.happened_at,
    note: row.note,
    frozenSteps: row.frozen_count,
    result: row.result,
    createdAt: row.created_at,
  }));
}

/**
 * Unfreezes the thresholds, so they start tracking the product again.
 *
 * The change keeps its frozen copy — that is the record of what the bar was — but
 * the live thresholds go back to being recomputed. A founder does this when the
 * before-and-after has served its purpose.
 */
export async function unfreezeThresholds(db: ScopedDb, actorUserId: string | null): Promise<void> {
  await db.exec(`UPDATE step_thresholds SET frozen_by_change_id = NULL WHERE project_id = $1`, [
    db.projectId,
  ]);
  await db.exec(
    `INSERT INTO audit_log (project_id, actor_user_id, action, subject)
     VALUES ($1, $2, 'change.unfrozen', 'funnel')`,
    [db.projectId, actorUserId],
  );
}

/** Postgres returns `numeric` as a string, so every one has to be converted once. */
function numberOrNull(value: string | null): number | null {
  return value === null ? null : Number(value);
}

/**
 * How many people entered and completed a step inside each window (brief §9).
 *
 * Counted from `user_step_state`'s `first_entered_at` and `first_completed_at` — the
 * FIRST time each person reached and finished the step, which is what the funnel's
 * own aggregates count, so the Changes module and the funnel cannot disagree about
 * what "entered" means.
 *
 * A person is counted in the window their first entry falls in, so someone who
 * entered before the change and completed after it stays on the "before" side. That
 * is the honest attribution: the change cannot have affected how they arrived.
 *
 * The windows arrive already computed by the engine — equal lengths either side,
 * capped by the plan — because the comparison is only honest if the two sides match,
 * and that is an arithmetic decision rather than a SQL one (CLAUDE.md rule 9).
 */
export interface ChangeWindowCounts {
  stepLabel: string;
  before: { entered: number; completed: number };
  after: { entered: number; completed: number };
}

export async function changeWindowCounts(
  db: ScopedDb,
  stepId: number,
  windows: {
    before: { from: Date; to: Date };
    after: { from: Date; to: Date };
  },
): Promise<ChangeWindowCounts> {
  const row = await db.one<{
    label: string;
    before_entered: string;
    before_completed: string;
    after_entered: string;
    after_completed: string;
  }>(
    `SELECT s.label,
            count(*) FILTER (WHERE e.first_entered_at >= $3
                               AND e.first_entered_at < $4) AS before_entered,
            count(*) FILTER (WHERE e.first_entered_at >= $3 AND e.first_entered_at < $4
                               AND e.first_completed_at IS NOT NULL) AS before_completed,
            count(*) FILTER (WHERE e.first_entered_at >= $5
                               AND e.first_entered_at < $6) AS after_entered,
            count(*) FILTER (WHERE e.first_entered_at >= $5 AND e.first_entered_at < $6
                               AND e.first_completed_at IS NOT NULL) AS after_completed
       FROM funnel_steps s
       LEFT JOIN user_step_state e
              ON e.project_id = s.project_id AND e.step_id = s.id
      WHERE s.project_id = $1 AND s.id = $2
      GROUP BY s.id, s.label`,
    [
      db.projectId,
      stepId,
      windows.before.from,
      windows.before.to,
      windows.after.from,
      windows.after.to,
    ],
  );

  return {
    stepLabel: row.label,
    before: { entered: Number(row.before_entered), completed: Number(row.before_completed) },
    after: { entered: Number(row.after_entered), completed: Number(row.after_completed) },
  };
}

/**
 * Freezes the comparison (brief §9: "Freeze the result when it is computed").
 *
 * `WHERE result IS NULL` so a frozen result is never overwritten. Once a founder has
 * been told their change moved completion from 40% to 60%, that sentence is part of
 * the record; recomputing it next week against a wider window would quietly rewrite
 * what they were told.
 */
export async function storeChangeResult(
  db: ScopedDb,
  changeId: string,
  result: unknown,
): Promise<boolean> {
  const updated = await db.exec(
    `UPDATE changes SET result = $3::jsonb
      WHERE project_id = $1 AND id = $2 AND result IS NULL`,
    [db.projectId, changeId, JSON.stringify(result)],
  );
  return updated > 0;
}

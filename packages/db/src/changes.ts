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

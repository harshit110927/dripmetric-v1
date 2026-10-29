import {
  currentProject,
  entitlementsFor,
  limitOf,
  withProject,
  withoutProject,
} from '@dripmetric/db';
import { localDayKey } from '@dripmetric/engine';
import { writeDailySummary } from './funnel/aggregate.js';

/**
 * Retention (brief §10).
 *
 * "A nightly job writes the day's summaries, then deletes raw events past the window:
 * 90 days on Free, 13 months on paid. Summaries are kept forever. Write the deletes
 * as batches by time range, so the table can be partitioned by month later."
 *
 * The ORDER is the requirement, not an implementation detail. A summary is derived
 * from raw events, so deleting first would destroy the only source the summary could
 * have come from — and the summaries are what outlive the window. `retention_runs`
 * records both halves so a run that deleted without summarising is visible after the
 * fact rather than being an argument about what must have happened.
 */

/**
 * One day of events per DELETE.
 *
 * By time range rather than by id or by `LIMIT`, because that is the shape a monthly
 * partition will want: when `events` is partitioned, a delete bounded by
 * `occurred_at` becomes a partition drop, and one bounded by anything else stays a
 * full scan. (Brief §10 also warns that the unique key on (project, message_id) will
 * then need the partition column.)
 */
export const RETENTION_BATCH_HOURS = 24;
/** A cap per run, so one project with years of history cannot hold the nightly pass. */
export const RETENTION_MAX_BATCHES = 40;

export interface RetentionResult {
  ran: boolean;
  why: string;
  retentionDays: number;
  cutoffAt: Date | null;
  summariesWritten: number;
  eventsDeleted: number;
  batches: number;
  /** True when the cap was reached and there is more to delete next time. */
  more: boolean;
}

export async function runRetention(projectId: number, now: Date): Promise<RetentionResult> {
  return withProject(
    projectId,
    async (db) => {
      const project = await currentProject(db);
      const plan = await entitlementsFor(db, projectId);
      const retentionDays = limitOf(plan, 'retention_days');
      const periodKey = localDayKey(now, project.timezone);

      const already = await db.maybeOne(
        `SELECT 1 FROM retention_runs WHERE project_id = $1 AND period_key = $2`,
        [db.projectId, periodKey],
      );
      if (already) {
        return skip(`Tonight's retention pass already ran (${periodKey}).`, retentionDays);
      }

      if (retentionDays <= 0) {
        return skip('This plan keeps raw events indefinitely.', retentionDays);
      }

      const cutoffAt = new Date(now.getTime() - retentionDays * 86_400_000);

      /*
       * SUMMARIES FIRST. This is the whole order-of-operations requirement.
       *
       * `writeDailySummary` writes one row for today and returns nothing, so the
       * count here is "did the summary for this run's day get written" rather than a
       * total. It is recorded because a retention run that deleted events without it
       * is the bug this ordering exists to prevent, and the row is the only evidence
       * after the events are gone.
       */
      await writeDailySummary(db, now);
      const summariesWritten = 1;

      const run = await db.one<{ id: string }>(
        `INSERT INTO retention_runs
           (project_id, period_key, retention_days, cutoff_at, summaries_written)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [db.projectId, periodKey, retentionDays, cutoffAt, summariesWritten],
      );

      let deleted = 0;
      let batches = 0;
      let more = false;

      for (; batches < RETENTION_MAX_BATCHES; batches++) {
        /*
         * The oldest day still present, then everything in that day.
         *
         * Asking for the oldest first means each DELETE covers a contiguous range
         * and the loop ends naturally when nothing older than the cutoff is left.
         */
        const oldest = await db.maybeOne<{ at: Date }>(
          `SELECT min(occurred_at) AS at FROM events
            WHERE project_id = $1 AND occurred_at < $2`,
          [db.projectId, cutoffAt],
        );
        if (!oldest?.at) break;

        const batchEnd = new Date(
          Math.min(oldest.at.getTime() + RETENTION_BATCH_HOURS * 3_600_000, cutoffAt.getTime()),
        );

        const removed = await db.exec(
          `DELETE FROM events
            WHERE project_id = $1 AND occurred_at >= $2 AND occurred_at < $3`,
          [db.projectId, oldest.at, batchEnd],
        );
        deleted += removed;

        if (batches === RETENTION_MAX_BATCHES - 1) more = true;
      }

      await db.exec(
        `UPDATE retention_runs
            SET events_deleted = $3, batches = $4, finished_at = $5
          WHERE project_id = $1 AND id = $2`,
        [db.projectId, run.id, deleted, batches, now],
      );

      return {
        ran: true,
        why: more ? 'Deleted up to the per-run cap; more remains for tomorrow.' : 'Done.',
        retentionDays,
        cutoffAt,
        summariesWritten,
        eventsDeleted: deleted,
        batches,
        more,
      };
    },
    { worker: true },
  );
}

function skip(why: string, retentionDays: number): RetentionResult {
  return {
    ran: false,
    why,
    retentionDays,
    cutoffAt: null,
    summariesWritten: 0,
    eventsDeleted: 0,
    batches: 0,
    more: false,
  };
}

/**
 * Unclaimed projects: stop ingesting at 14 days, delete at 30 (brief §9's free audit).
 *
 * Here rather than in the setup flow because it is a retention rule, and because the
 * nightly pass is the only thing that runs without someone being logged in.
 */
export const UNCLAIMED_STOP_DAYS = 14;
export const UNCLAIMED_DELETE_DAYS = 30;

export interface UnclaimedResult {
  stopped: number;
  deleted: number;
}

export async function sweepUnclaimedProjects(now: Date): Promise<UnclaimedResult> {
  return withoutProject(
    'worker-sweep',
    async (db) => {
      const stopAt = new Date(now.getTime() - UNCLAIMED_STOP_DAYS * 86_400_000);
      const deleteAt = new Date(now.getTime() - UNCLAIMED_DELETE_DAYS * 86_400_000);

      /*
       * Stopped by revoking the keys, not by a flag.
       *
       * Ingest already refuses a revoked key, so this needs no new branch on the hot
       * path — and a founder who then claims the project gets a clear "rotate your
       * key" rather than silently working again.
       */
      const stopped = await db.exec(
        `UPDATE api_keys SET revoked_at = $1
           WHERE revoked_at IS NULL
             AND project_id IN (
               SELECT id FROM projects
                WHERE claimed_at IS NULL AND deleted_at IS NULL AND created_at < $2
             )`,
        [now, stopAt],
      );

      const deleted = await db.exec(
        `UPDATE projects SET deleted_at = $1
           WHERE claimed_at IS NULL AND deleted_at IS NULL AND created_at < $2`,
        [now, deleteAt],
      );

      return { stopped, deleted };
    },
    { worker: true },
  );
}

import type { ScopedDb } from '@dripmetric/db';
import { withProject, withoutProject } from '@dripmetric/db';
import {
  applyStepUpdates,
  loadFunnel,
  matchSteps,
  type FunnelConfig,
  type StepUpdate,
} from './pipeline/step-state.js';

/**
 * The `recompute` job (brief §7, CLAUDE.md rule 10).
 *
 * "Derived state is rebuildable. Step state, scores, leaks and summaries must be
 * reproducible from raw events plus settings by an idempotent `recompute` job, so a
 * bug in a rule is fixed by changing the rule and recomputing."
 *
 * That is the whole reason a founder can change a mapping without splitting their
 * history. It also means a bug in the step rules is fixed by shipping the fix and
 * running this, rather than by apologising about last month's numbers.
 *
 * Three properties it has to have:
 *
 *  - **Idempotent.** Running it twice gives the same state as running it once.
 *  - **Equivalent.** Recomputing after a mapping change gives the same state as
 *    ingesting the same events with the final mapping from the start. That is the
 *    brief's own exit check, and it is tested.
 *  - **Resumable in chunks.** A project with 13 months of events is not one
 *    transaction, so the cursor is stored and a run that dies picks up where it
 *    stopped.
 */

/** Events per chunk. Small enough for one transaction, large enough to be quick. */
export const RECOMPUTE_CHUNK_SIZE = 5000;

export const RECOMPUTE_REASONS = ['mapping', 'url-rule', 'funnel', 'manual', 'settings'] as const;
export type RecomputeReason = (typeof RECOMPUTE_REASONS)[number];

export interface RecomputeProgress {
  runId: string;
  eventsSeen: number;
  done: boolean;
}

/**
 * Queues a recompute. One at a time per project: a second run would rebuild the same
 * rows from the same events and race the first (enforced by a partial unique index).
 */
export async function queueRecompute(
  db: ScopedDb,
  reason: RecomputeReason,
): Promise<{ runId: string; alreadyQueued: boolean }> {
  const existing = await db.maybeOne<{ id: string }>(
    `SELECT id FROM recompute_runs
      WHERE project_id = $1 AND state IN ('pending', 'running')
      LIMIT 1`,
    [db.projectId],
  );
  if (existing) return { runId: existing.id, alreadyQueued: true };

  const run = await db.one<{ id: string }>(
    `INSERT INTO recompute_runs (project_id, reason) VALUES ($1, $2) RETURNING id`,
    [db.projectId, reason],
  );
  return { runId: run.id, alreadyQueued: false };
}

/**
 * Runs one chunk of a recompute, and returns whether there is more to do.
 *
 * Each chunk is its own transaction, so a worker restart loses at most one chunk's
 * work. The FIRST chunk clears the derived state, because rows built from the old
 * mapping must not survive — order-insensitive merging makes rebuilding safe, but it
 * cannot remove a step that no longer exists.
 */
export async function recomputeChunk(
  projectId: number,
  now: Date,
  chunkSize = RECOMPUTE_CHUNK_SIZE,
): Promise<RecomputeProgress | null> {
  return withProject(
    projectId,
    async (db) => {
      const run = await db.maybeOne<{
        id: string;
        state: string;
        cursor_occurred_at: Date | null;
        cursor_message_hash: string | null;
        events_seen: string;
      }>(
        `SELECT id, state, cursor_occurred_at, cursor_message_hash, events_seen
           FROM recompute_runs
          WHERE project_id = $1 AND state IN ('pending', 'running')
          ORDER BY created_at
          LIMIT 1
          FOR UPDATE`,
        [db.projectId],
      );
      if (!run) return null;

      const firstChunk = run.state === 'pending';

      if (firstChunk) {
        await db.exec(
          `UPDATE recompute_runs SET state = 'running', started_at = $2 WHERE id = $1`,
          [run.id, now],
        );
        /*
         * Clear the derived state before rebuilding.
         *
         * The merge is order-insensitive, so replaying events over existing rows
         * would be safe — but it cannot REMOVE a row. A step whose event name just
         * changed, or a step deleted from the funnel, would otherwise keep its old
         * state forever and the founder would see a stage that no longer exists.
         */
        await db.exec('DELETE FROM user_step_state WHERE project_id = $1', [db.projectId]);
      }

      const funnel = await loadFunnel(db);

      // Events in a stable total order, so the cursor can resume exactly.
      const events = await db.query<{
        message_hash: string;
        occurred_at: Date;
        user_key: number | null;
        session_id: string | null;
        canonical: string | null;
        props: Record<string, unknown> | null;
        path: string | null;
      }>(
        `SELECT e.message_hash, e.occurred_at, e.user_key, e.session_id,
                n.canonical, e.props, p.path
           FROM events e
           JOIN event_names n ON n.project_id = e.project_id AND n.id = e.name_id
           LEFT JOIN paths p ON p.project_id = e.project_id AND p.id = e.path_id
          WHERE e.project_id = $1
            AND e.user_key IS NOT NULL
            AND ($2::timestamptz IS NULL
                 OR (e.occurred_at, e.message_hash) > ($2::timestamptz, $3::uuid))
          ORDER BY e.occurred_at, e.message_hash
          LIMIT $4`,
        [db.projectId, run.cursor_occurred_at, run.cursor_message_hash, chunkSize],
      );

      /*
       * A short chunk is the LAST chunk, and the run has to be marked done here.
       *
       * Marking it done only when a chunk comes back empty left the run `running`
       * for ever after a single-chunk rebuild — and because `queueRecompute` joins
       * an existing run rather than starting a second, every later mapping change
       * silently never recomputed. The founder would change a mapping, see nothing
       * happen, and have no way to tell why.
       */
      const lastChunk = events.length < chunkSize;

      if (events.length === 0) {
        await finish(db, run.id, now);
        return { runId: run.id, eventsSeen: Number(run.events_seen), done: true };
      }

      const updates: StepUpdate[] = [];
      for (const event of events) {
        if (event.user_key === null) continue;
        updates.push(...stepUpdatesFor(funnel, event));
      }

      // applyStepUpdates merges a batch to one row per (person, step), with the same
      // semantics ingest uses — which is exactly why the result is equivalent.
      await applyStepUpdates(db, updates);

      const last = events[events.length - 1]!;
      const seen = Number(run.events_seen) + events.length;
      await db.exec(
        `UPDATE recompute_runs
            SET cursor_occurred_at = $2, cursor_message_hash = $3, events_seen = $4
          WHERE id = $1`,
        [run.id, last.occurred_at, last.message_hash, seen],
      );

      if (lastChunk) await finish(db, run.id, now);

      return { runId: run.id, eventsSeen: seen, done: lastChunk };
    },
    { worker: true },
  );
}

async function finish(db: ScopedDb, runId: string, now: Date): Promise<void> {
  await db.exec(`UPDATE recompute_runs SET state = 'done', finished_at = $2 WHERE id = $1`, [
    runId,
    now,
  ]);
}

interface RecomputableEvent {
  user_key: number | null;
  session_id: string | null;
  occurred_at: Date;
  canonical: string | null;
  props: Record<string, unknown> | null;
  path: string | null;
}

/**
 * The step updates one stored event implies.
 *
 * This reads the SAME pure `matchSteps` the live pipeline reads, from the same
 * funnel. That is not a convenience — it is the only reason recompute and ingest
 * cannot drift apart. Two implementations of "which step does this event touch"
 * would eventually disagree, and the disagreement would look like a data bug.
 */
export function stepUpdatesFor(funnel: FunnelConfig, event: RecomputableEvent): StepUpdate[] {
  if (event.user_key === null) return [];

  const props = event.props ?? {};
  const stepLabel = typeof props['step'] === 'string' ? props['step'] : null;
  const activeSeconds = typeof props['activeSeconds'] === 'number' ? props['activeSeconds'] : 0;

  return matchSteps(funnel, event.canonical, stepLabel, event.path).map((match) => ({
    userKey: event.user_key!,
    stepId: match.stepId,
    kind: match.kind,
    at: event.occurred_at,
    activeSeconds,
    sessionId: event.session_id === null ? null : Number(event.session_id),
  }));
}

/**
 * Projects with a recompute waiting.
 *
 * The web app queues a run by writing a row (`queueRecompute`) rather than by
 * talking to the queue: the request path has no queue client at all, which keeps
 * pg-boss out of the Next.js bundle and off Supabase's transaction pooler. The
 * worker finds the work here.
 */
export async function pendingRecomputeProjects(limit = 100): Promise<number[]> {
  return withoutProject(
    'worker-sweep',
    async (db) => {
      const rows = await db.query<{ project_id: number }>(
        `SELECT DISTINCT project_id
           FROM recompute_runs
          WHERE state IN ('pending', 'running')
          ORDER BY project_id
          LIMIT $1`,
        [limit],
      );
      return rows.map((row) => row.project_id);
    },
    { worker: true },
  );
}

/** Runs a whole recompute to completion. Used by the worker and by tests. */
export async function recomputeProject(
  projectId: number,
  now: Date,
  chunkSize = RECOMPUTE_CHUNK_SIZE,
): Promise<{ eventsSeen: number; chunks: number }> {
  let chunks = 0;
  let eventsSeen = 0;

  for (;;) {
    const progress = await recomputeChunk(projectId, now, chunkSize);
    if (progress === null) break;
    chunks += 1;
    eventsSeen = progress.eventsSeen;
    if (progress.done) break;
    // A runaway guard: a project with a billion events should fail loudly rather
    // than loop forever on a cursor that is not advancing.
    if (chunks > 10_000) throw new Error('recompute did not finish in 10,000 chunks');
  }

  return { eventsSeen, chunks };
}

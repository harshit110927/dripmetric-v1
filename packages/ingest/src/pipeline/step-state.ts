import type { ScopedDb } from '@dripmetric/db';

/**
 * `user_step_state`, written in the same transaction as the event.
 *
 * Two properties carry this file:
 *
 *  1. **Order-insensitive.** It keeps the EARLIEST entered time and the EARLIEST
 *     completed time, so an event arriving late or out of order can never corrupt it
 *     (brief section 5). That is why a replay gives identical state and why
 *     `recompute` can rebuild it from raw events alone.
 *  2. **Matched in memory.** The funnel is a handful of rows, so it is loaded once
 *     per batch and matched in JavaScript. Matching with SQL cost four queries per
 *     event, which is most of the ingest hot path for no benefit.
 */

export interface StepDefinition {
  stepId: number;
  label: string;
  /** A step is reached by a canonical event name, or by a URL rule, or both. */
  eventName: string | null;
  urlPattern: string | null;
}

export interface FunnelConfig {
  steps: readonly StepDefinition[];
}

export const EMPTY_FUNNEL: FunnelConfig = { steps: [] };

/** Loaded once per batch. A project with no funnel yet costs one query, then nothing. */
export async function loadFunnel(db: ScopedDb): Promise<FunnelConfig> {
  const rows = await db.query<{
    id: number;
    label: string;
    event_name: string | null;
    pattern: string | null;
  }>(
    `SELECT s.id, s.label, s.event_name, r.pattern
       FROM funnel_steps s
       JOIN funnels f ON f.project_id = s.project_id AND f.id = s.funnel_id AND f.is_active
       LEFT JOIN url_rules r ON r.project_id = s.project_id AND r.id = s.url_rule_id
      WHERE s.project_id = $1
      ORDER BY s.position`,
    [db.projectId],
  );

  return {
    steps: rows.map((r) => ({
      stepId: r.id,
      label: r.label,
      eventName: r.event_name,
      urlPattern: r.pattern,
    })),
  };
}

export interface StepMatch {
  stepId: number;
  kind: 'entered' | 'completed';
}

/**
 * Which steps this event touches. A pure function of the funnel and the event, so
 * M6's funnel engine and `recompute` can call it with no database at all.
 */
export function matchSteps(
  funnel: FunnelConfig,
  canonicalName: string | null,
  stepLabel: string | null,
  path: string | null,
): StepMatch[] {
  if (funnel.steps.length === 0) return [];
  const matches: StepMatch[] = [];

  for (const step of funnel.steps) {
    // The founder's own step events, carrying the step's name as a property.
    if (stepLabel !== null && step.label === stepLabel) {
      if (canonicalName === 'Onboarding Step Completed')
        matches.push({ stepId: step.stepId, kind: 'completed' });
      if (canonicalName === 'Onboarding Step Viewed')
        matches.push({ stepId: step.stepId, kind: 'entered' });
    }

    // A step defined directly by a canonical event, e.g. Activated.
    if (
      step.eventName !== null &&
      canonicalName === step.eventName &&
      canonicalName !== 'Onboarding Step Completed' &&
      canonicalName !== 'Onboarding Step Viewed'
    ) {
      matches.push({ stepId: step.stepId, kind: 'completed' });
    }

    // A URL-rule step: reaching the page enters the step.
    if (step.urlPattern !== null && path !== null && matchesPattern(path, step.urlPattern)) {
      matches.push({ stepId: step.stepId, kind: 'entered' });
    }
  }
  return matches;
}

/** `/onboarding/step-*` style globs, the only wildcard URL rules support. */
export function matchesPattern(path: string, pattern: string): boolean {
  if (!pattern.includes('*')) return path === pattern;
  const regex = new RegExp(
    '^' +
      pattern
        .split('*')
        .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*') +
      '$',
  );
  return regex.test(path);
}

export interface StepUpdate {
  userKey: number;
  stepId: number;
  kind: 'entered' | 'completed';
  at: Date;
  activeSeconds: number;
  /** Which session it happened in, so `visits` can count distinct sessions. */
  sessionId: number | null;
}

/** One row per (person, step), after merging everything the batch said about it. */
export interface MergedStepUpdate {
  userKey: number;
  stepId: number;
  firstEnteredAt: Date | null;
  firstCompletedAt: Date | null;
  attempts: number;
  activeSeconds: number;
  lastEventAt: Date;
  /**
   * The sessions this batch saw on this step.
   *
   * Not a count. `visits` is "separate sessions spent on the step" (brief §8.1) and
   * a count taken here could only ever know about one batch, so the sessions
   * themselves are stored and `visits` is recounted from them.
   */
  sessions: number[];
}

/**
 * Merges a batch's step updates down to one row per (person, step).
 *
 * This is not an optimisation. A multi-row `INSERT … ON CONFLICT DO UPDATE` whose
 * rows collide with each other fails outright — "ON CONFLICT DO UPDATE command
 * cannot affect row a second time" — and a batch routinely carries two updates for
 * the same person and step, because entering a step and completing it are two
 * events. The simulator is what surfaced it: 1,065 of 6,458 messages failed with a
 * 500 the moment a funnel existed to match against.
 *
 * The merge keeps the same semantics the SQL does, so the result is identical to
 * applying the updates one at a time: earliest entered, earliest completed, attempts
 * summed, active time summed, latest event time.
 */
export function mergeStepUpdates(updates: readonly StepUpdate[]): MergedStepUpdate[] {
  const merged = new Map<string, Omit<MergedStepUpdate, 'sessions'> & { sessions: Set<number> }>();

  for (const update of updates) {
    const key = `${update.userKey}:${update.stepId}`;
    let row = merged.get(key);

    if (!row) {
      row = {
        userKey: update.userKey,
        stepId: update.stepId,
        firstEnteredAt: null,
        firstCompletedAt: null,
        attempts: 0,
        activeSeconds: 0,
        lastEventAt: update.at,
        sessions: new Set<number>(),
      };
      merged.set(key, row);
    }

    if (update.kind === 'entered') {
      row.firstEnteredAt =
        row.firstEnteredAt === null || update.at < row.firstEnteredAt
          ? update.at
          : row.firstEnteredAt;
    } else {
      row.firstCompletedAt =
        row.firstCompletedAt === null || update.at < row.firstCompletedAt
          ? update.at
          : row.firstCompletedAt;
    }

    row.attempts += 1;
    row.activeSeconds += Math.max(0, Math.round(update.activeSeconds));
    if (update.at > row.lastEventAt) row.lastEventAt = update.at;
    if (update.sessionId !== null) row.sessions.add(update.sessionId);
  }

  return [...merged.values()].map(({ sessions, ...row }) => ({
    ...row,
    sessions: [...sessions],
  }));
}

/**
 * Writes a batch of step updates in one statement.
 *
 * LEAST() on both timestamps is what makes it order-insensitive: whichever event
 * arrives second, the stored time is the earlier of the two.
 */
export async function applyStepUpdates(
  db: ScopedDb,
  updates: readonly StepUpdate[],
): Promise<void> {
  const merged = mergeStepUpdates(updates);
  if (merged.length === 0) return;

  // The sessions first, in the same transaction, so the recount below sees them.
  await writeStepSessions(db, merged);

  /*
   * `visits` is SET, not incremented.
   *
   * Every other column here accumulates, which is what makes a replay safe for them
   * (sum of the same events, earliest of the same times). A count of distinct
   * sessions cannot accumulate: adding this batch's count to the stored one would
   * count a returning visitor's session twice the moment two batches mentioned it.
   * So it is recounted from `user_step_sessions`, which is a set and therefore
   * idempotent — the same property, reached the other way round.
   */
  await db.exec(
    `WITH incoming AS (
       SELECT * FROM unnest($2::int[], $3::int[], $4::timestamptz[], $5::timestamptz[],
                            $6::int[], $7::int[], $8::timestamptz[])
              AS u(user_key, step_id, entered_at, completed_at, attempts, active_seconds, at)
     ), counted AS (
       SELECT i.user_key, i.step_id, count(s.session_id)::int AS visits
         FROM incoming i
         LEFT JOIN user_step_sessions s
           ON s.project_id = $1 AND s.user_key = i.user_key AND s.step_id = i.step_id
        GROUP BY i.user_key, i.step_id
     )
     INSERT INTO user_step_state (
       project_id, user_key, step_id, first_entered_at, first_completed_at,
       attempts, visits, active_seconds, last_event_at
     )
     SELECT $1, i.user_key, i.step_id, i.entered_at, i.completed_at,
            i.attempts, c.visits, i.active_seconds, i.at
       FROM incoming i
       JOIN counted c ON c.user_key = i.user_key AND c.step_id = i.step_id
     ON CONFLICT (project_id, user_key, step_id) DO UPDATE SET
       first_entered_at   = LEAST(user_step_state.first_entered_at,   COALESCE(EXCLUDED.first_entered_at,   user_step_state.first_entered_at)),
       first_completed_at = LEAST(user_step_state.first_completed_at, COALESCE(EXCLUDED.first_completed_at, user_step_state.first_completed_at)),
       attempts       = user_step_state.attempts + EXCLUDED.attempts,
       visits         = EXCLUDED.visits,
       active_seconds = user_step_state.active_seconds + EXCLUDED.active_seconds,
       last_event_at  = GREATEST(user_step_state.last_event_at, EXCLUDED.last_event_at)`,
    [
      db.projectId,
      merged.map((u) => u.userKey),
      merged.map((u) => u.stepId),
      merged.map((u) => u.firstEnteredAt),
      merged.map((u) => u.firstCompletedAt),
      merged.map((u) => u.attempts),
      merged.map((u) => u.activeSeconds),
      merged.map((u) => u.lastEventAt),
    ],
  );
}

/** One row per (person, step, session). A set, so a replay adds nothing. */
async function writeStepSessions(db: ScopedDb, merged: readonly MergedStepUpdate[]): Promise<void> {
  const userKeys: number[] = [];
  const stepIds: number[] = [];
  const sessionIds: number[] = [];

  for (const row of merged) {
    for (const sessionId of row.sessions) {
      userKeys.push(row.userKey);
      stepIds.push(row.stepId);
      sessionIds.push(sessionId);
    }
  }
  // A server-side event has no session of its own, so there is nothing to record.
  if (sessionIds.length === 0) return;

  await db.exec(
    `INSERT INTO user_step_sessions (project_id, user_key, step_id, session_id)
     SELECT $1, u.user_key, u.step_id, u.session_id
       FROM unnest($2::int[], $3::int[], $4::bigint[]) AS u(user_key, step_id, session_id)
     ON CONFLICT DO NOTHING`,
    [db.projectId, userKeys, stepIds, sessionIds],
  );
}

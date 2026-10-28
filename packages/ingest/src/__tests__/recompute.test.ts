import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  closePools,
  confirmMapping,
  inbox,
  storeSuggestions,
  withProject,
  type ScopedDb,
} from '@dripmetric/db';
import { queueRecompute, recomputeProject } from '../recompute.js';
import {
  ensureMigrated,
  newFixture,
  postBatch,
  resetData,
  track,
  type Fixture,
} from './helpers.js';

/**
 * M5 exit checks (brief §11):
 *
 *   "with simulator data that uses renamed events, the Inbox lists the unmapped names"
 *   "confirming one recomputes history"
 *   "the equivalence test passes"
 *
 * The last one is the important one: recomputing after a mapping change must give
 * the SAME state as ingesting the same events with the final mapping from the start.
 * Without it, a founder who fixes a mapping gets a history that is neither the old
 * answer nor the right one.
 */

/** A funnel whose last step is reached by the founder's OWN event name. */
async function configureFunnel(db: ScopedDb, coreActionName: string): Promise<void> {
  const funnel = await db.one<{ id: number }>(
    `INSERT INTO funnels (project_id, name) VALUES ($1, 'Onboarding') RETURNING id`,
    [db.projectId],
  );
  const steps = [
    { label: 'Create account', eventName: 'Signed Up' },
    { label: 'Do the thing', eventName: 'Core Action' },
    { label: 'Activated', eventName: 'Activated' },
  ];
  for (const [position, step] of steps.entries()) {
    await db.exec(
      `INSERT INTO funnel_steps (project_id, funnel_id, position, label, event_name, importance)
       VALUES ($1, $2, $3, $4, $5, 'key')`,
      [db.projectId, funnel.id, position, step.label, step.eventName],
    );
  }
  // The founder's own name exists in the dictionary but is NOT yet mapped, which is
  // the whole point: it is in the Inbox and counts toward nothing.
  void coreActionName;
}

/** Step state, in a shape two runs can be compared by. */
async function stepState(projectId: number): Promise<string> {
  const rows = await withProject(projectId, (db) =>
    db.query<{
      external_id: string;
      label: string;
      entered: string | null;
      completed: string | null;
      attempts: number;
    }>(
      `SELECT u.external_id, s.label,
              to_char(st.first_entered_at   AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS entered,
              to_char(st.first_completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS completed,
              st.attempts
         FROM user_step_state st
         JOIN funnel_steps s ON s.project_id = st.project_id AND s.id = st.step_id
         JOIN end_users u ON u.project_id = st.project_id AND u.user_key = st.user_key
        WHERE st.project_id = $1
        ORDER BY u.external_id, s.position`,
      [projectId],
    ),
  );
  return JSON.stringify(rows, null, 1);
}

describe('recompute', () => {
  let fx: Fixture;

  beforeAll(ensureMigrated);
  beforeEach(async () => {
    await resetData();
    fx = await newFixture();
  });
  afterAll(closePools);

  /** The founder's own name for their core action, as a real product would send. */
  const OWN_NAME = 'invoice_sent';

  async function sendJourneys(key: string): Promise<void> {
    const at = (minutes: number) => new Date(Date.UTC(2026, 5, 1, 10, minutes, 0)).toISOString();
    const batch: unknown[] = [];

    for (const user of ['user_a', 'user_b', 'user_c']) {
      batch.push(track('Signed Up', { messageId: `${user}-1`, userId: user, timestamp: at(0) }));
      // Their own name, twice, which should become two attempts at the middle step.
      batch.push(track(OWN_NAME, { messageId: `${user}-2`, userId: user, timestamp: at(5) }));
      batch.push(track(OWN_NAME, { messageId: `${user}-3`, userId: user, timestamp: at(9) }));
      if (user !== 'user_c') {
        batch.push(track('Activated', { messageId: `${user}-4`, userId: user, timestamp: at(20) }));
      }
    }

    await postBatch(batch, {
      key,
      receivedAt: new Date(Date.UTC(2026, 5, 1, 10, 30, 0)),
      sentAt: new Date(Date.UTC(2026, 5, 1, 10, 30, 0)).toISOString(),
    });
  }

  it('lists the founder’s own unmapped names in the Inbox', async () => {
    await withProject(fx.project.live.id, (db) => configureFunnel(db, OWN_NAME));
    await sendJourneys(fx.secretKey);

    const waiting = await withProject(fx.project.live.id, inbox);
    const names = waiting.map((entry) => entry.rawName);

    // The founder's own name is waiting; the canonical ones mapped themselves.
    expect(names).toContain(OWN_NAME);
    expect(names).not.toContain('Signed Up');
    expect(names).not.toContain('Activated');

    const entry = waiting.find((e) => e.rawName === OWN_NAME)!;
    expect(entry.status).toBe('unmapped');
    expect(entry.canonical).toBeNull();
    expect(entry.eventCount).toBe(6); // three people, twice each
  });

  it('counts an unmapped name toward nothing until it is confirmed', async () => {
    await withProject(fx.project.live.id, (db) => configureFunnel(db, OWN_NAME));
    await sendJourneys(fx.secretKey);

    // The middle step is reached by Core Action, and nothing is mapped to it yet,
    // so no one has reached it — however many invoices they sent.
    const before = await stepState(fx.project.live.id);
    expect(before).not.toContain('Do the thing');
    expect(before).toContain('Create account');
  });

  it('confirming a mapping recomputes history', async () => {
    await withProject(fx.project.live.id, (db) => configureFunnel(db, OWN_NAME));
    await sendJourneys(fx.secretKey);

    const changed = await withProject(fx.project.live.id, (db) =>
      confirmMapping(db, OWN_NAME, 'Core Action', null, new Date()),
    );
    expect(changed).toBe(true);

    await withProject(fx.project.live.id, (db) => queueRecompute(db, 'mapping'));
    const result = await recomputeProject(fx.project.live.id, new Date());
    expect(result.eventsSeen).toBeGreaterThan(0);

    // Now the middle step exists in history, for events sent before the mapping.
    const after = await stepState(fx.project.live.id);
    expect(after).toContain('Do the thing');
    // Two invoices each: two attempts, completed at the first one.
    expect(after).toContain('"attempts": 2');
    expect(after).toContain('10:05:00');
  });

  it('EQUIVALENCE: recomputing matches ingesting with the final mapping from the start', async () => {
    /*
     * The brief's own exit check, and the reason recompute can be trusted.
     *
     * Project A: events arrive while the name is unmapped, the founder then maps it,
     * and history is rebuilt.
     * Project B: the mapping exists first, so ingest gets it right live.
     *
     * The two must end up byte-identical. If they ever differ, a founder who fixes
     * a mapping gets a history that is neither the old answer nor the right one.
     */
    const b = await newFixture('Mapped from the start');

    // --- A: map it afterwards, then recompute ---------------------------------
    await withProject(fx.project.live.id, (db) => configureFunnel(db, OWN_NAME));
    await sendJourneys(fx.secretKey);
    await withProject(fx.project.live.id, (db) =>
      confirmMapping(db, OWN_NAME, 'Core Action', null, new Date()),
    );
    await withProject(fx.project.live.id, (db) => queueRecompute(db, 'mapping'));
    await recomputeProject(fx.project.live.id, new Date());

    // --- B: the mapping is already there when the events arrive ---------------
    await withProject(b.project.live.id, async (db) => {
      await configureFunnel(db, OWN_NAME);
      await db.exec(
        `INSERT INTO event_names (project_id, raw_name, canonical, status, confidence)
         VALUES ($1, $2, 'Core Action', 'confirmed', 'high')`,
        [db.projectId, OWN_NAME],
      );
    });
    await sendJourneys(b.secretKey);

    expect(await stepState(fx.project.live.id)).toBe(await stepState(b.project.live.id));
  });

  it('is idempotent: running it twice gives the same state as once', async () => {
    await withProject(fx.project.live.id, (db) => configureFunnel(db, OWN_NAME));
    await sendJourneys(fx.secretKey);
    await withProject(fx.project.live.id, (db) =>
      confirmMapping(db, OWN_NAME, 'Core Action', null, new Date()),
    );

    await withProject(fx.project.live.id, (db) => queueRecompute(db, 'mapping'));
    await recomputeProject(fx.project.live.id, new Date());
    const once = await stepState(fx.project.live.id);

    await withProject(fx.project.live.id, (db) => queueRecompute(db, 'manual'));
    await recomputeProject(fx.project.live.id, new Date());
    const twice = await stepState(fx.project.live.id);

    expect(twice).toBe(once);
  });

  it('removes state for a step that no longer means anything', async () => {
    // The reason the first chunk clears derived state: order-insensitive merging
    // can add and update, but it cannot remove a stage that has gone away.
    await withProject(fx.project.live.id, (db) => configureFunnel(db, OWN_NAME));
    await sendJourneys(fx.secretKey);
    await withProject(fx.project.live.id, (db) =>
      confirmMapping(db, OWN_NAME, 'Core Action', null, new Date()),
    );
    await withProject(fx.project.live.id, (db) => queueRecompute(db, 'mapping'));
    await recomputeProject(fx.project.live.id, new Date());
    expect(await stepState(fx.project.live.id)).toContain('Do the thing');

    // The founder changes their mind: the name is noise after all.
    await withProject(fx.project.live.id, (db) =>
      confirmMapping(db, OWN_NAME, null, null, new Date()),
    );
    await withProject(fx.project.live.id, (db) => queueRecompute(db, 'mapping'));
    await recomputeProject(fx.project.live.id, new Date());

    expect(await stepState(fx.project.live.id)).not.toContain('Do the thing');
  });

  it('resumes from its cursor rather than starting over', async () => {
    await withProject(fx.project.live.id, (db) => configureFunnel(db, OWN_NAME));
    await sendJourneys(fx.secretKey);
    await withProject(fx.project.live.id, (db) =>
      confirmMapping(db, OWN_NAME, 'Core Action', null, new Date()),
    );
    await withProject(fx.project.live.id, (db) => queueRecompute(db, 'mapping'));

    // One event at a time, so the cursor is exercised rather than skipped.
    const result = await recomputeProject(fx.project.live.id, new Date(), 1);
    expect(result.chunks).toBeGreaterThan(5);

    const run = await withProject(fx.project.live.id, (db) =>
      db.query<{ state: string; events_seen: string }>(
        'SELECT state, events_seen FROM recompute_runs ORDER BY created_at DESC LIMIT 1',
      ),
    );
    expect(run[0]?.state).toBe('done');
    expect(Number(run[0]?.events_seen)).toBe(result.eventsSeen);

    // And the answer is the same as a single-chunk run would give.
    expect(await stepState(fx.project.live.id)).toContain('Do the thing');
  });

  it('finishes a run, so the NEXT mapping change still recomputes', async () => {
    /*
     * A run was only marked done when a chunk came back EMPTY, so a rebuild that
     * fitted in one chunk left the run `running` for ever. Because queueRecompute
     * joins an existing run rather than starting a second, every later mapping
     * change then silently did nothing: the founder changes a mapping, sees no
     * change, and has no way to tell why. Found by tracing a failing removal test.
     */
    await withProject(fx.project.live.id, (db) => configureFunnel(db, OWN_NAME));
    await sendJourneys(fx.secretKey);

    await withProject(fx.project.live.id, (db) => queueRecompute(db, 'mapping'));
    await recomputeProject(fx.project.live.id, new Date());

    const runs = await withProject(fx.project.live.id, (db) =>
      db.query<{ state: string }>('SELECT state FROM recompute_runs ORDER BY created_at'),
    );
    expect(runs.map((r) => r.state)).toEqual(['done']);

    // And a second change is genuinely a second run, not a join onto a stale one.
    const second = await withProject(fx.project.live.id, (db) => queueRecompute(db, 'funnel'));
    expect(second.alreadyQueued).toBe(false);
  });

  it('counts every occurrence of a name, not every batch', async () => {
    /*
     * event_count was incremented inside resolveNameId, which caches per batch, so
     * six events with one name counted once. The founder sees this number in the
     * Inbox, and the AI prompt uses it to choose the top 60 names by volume — an
     * undercount is a wrong screen and a wrong prompt.
     */
    await withProject(fx.project.live.id, (db) => configureFunnel(db, OWN_NAME));
    await sendJourneys(fx.secretKey);

    const entries = await withProject(fx.project.live.id, inbox);
    const own = entries.find((e) => e.rawName === OWN_NAME);
    // Three people, twice each, all in ONE batch.
    expect(own?.eventCount).toBe(6);

    // A second batch adds to it rather than replacing it.
    await postBatch([track(OWN_NAME, { messageId: 'extra-1', userId: 'user_a' })], {
      key: fx.secretKey,
    });
    const after = await withProject(fx.project.live.id, inbox);
    expect(after.find((e) => e.rawName === OWN_NAME)?.eventCount).toBe(7);
  });

  it('queues one run at a time per project', async () => {
    const first = await withProject(fx.project.live.id, (db) => queueRecompute(db, 'mapping'));
    const second = await withProject(fx.project.live.id, (db) => queueRecompute(db, 'funnel'));

    // A second run would rebuild the same rows from the same events and race the
    // first, so it joins the one already queued.
    expect(second.alreadyQueued).toBe(true);
    expect(second.runId).toBe(first.runId);
  });

  it('stores suggestions without overwriting what the founder decided', async () => {
    await withProject(fx.project.live.id, (db) => configureFunnel(db, OWN_NAME));
    await sendJourneys(fx.secretKey);

    await withProject(fx.project.live.id, (db) =>
      storeSuggestions(db, [
        {
          rawName: OWN_NAME,
          canonical: 'Core Action',
          confidence: 'high',
          reason: 'It is their core action.',
        },
      ]),
    );

    let waiting = await withProject(fx.project.live.id, inbox);
    const suggested = waiting.find((e) => e.rawName === OWN_NAME)!;
    expect(suggested.status).toBe('suggested');
    expect(suggested.canonical).toBe('Core Action');
    expect(suggested.reason).toContain('core action');

    // The founder disagrees and ignores it.
    await withProject(fx.project.live.id, (db) =>
      confirmMapping(db, OWN_NAME, null, null, new Date()),
    );

    // A later suggestion run must not quietly undo their decision.
    await withProject(fx.project.live.id, (db) =>
      storeSuggestions(db, [
        {
          rawName: OWN_NAME,
          canonical: 'Activated',
          confidence: 'high',
          reason: 'Second thoughts.',
        },
      ]),
    );

    waiting = await withProject(fx.project.live.id, inbox);
    expect(waiting.find((e) => e.rawName === OWN_NAME)).toBeUndefined();
  });
});

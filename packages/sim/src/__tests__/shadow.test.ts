import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import {
  closePools,
  createProject,
  reconcile,
  resetDbEnvCache,
  resetShadowStats,
  shadowConfigured,
  shadowStats,
  withoutProject,
} from '@dripmetric/db';
import { copyBatchToShadow, handleBatch } from '@dripmetric/ingest';
import { runSimulation } from '../run.js';
import { product } from '../products/index.js';
import { configureProject } from '../setup.js';
import { keysOf } from './send.js';
import { ensureMigrated, resetData } from './db.js';

/**
 * The shadow copy (settled decision 1, M13).
 *
 * Two exit checks live here, and they pull in opposite directions: the shadow must be
 * complete enough to restore from, and it must be impossible for it to slow ingest
 * down. The first is proven by reconciling a real simulator run; the second by
 * pointing the shadow at a port with nothing behind it and timing ingest anyway.
 *
 * Skipped when no shadow is configured, because the shadow is a safety net being
 * built towards rather than a dependency — and a test suite that failed without one
 * would make `pnpm test` depend on a second database.
 */

const SHADOW_URL =
  process.env['SHADOW_DATABASE_URL'] ??
  'postgres://dripmetric:dripmetric@localhost:54330/dripmetric_shadow';

/** A port with nothing listening, for the "killed shadow" case. */
const DEAD_SHADOW_URL = 'postgres://dripmetric:dripmetric@localhost:54399/nothing_here';

async function shadowReachable(): Promise<boolean> {
  const client = new pg.Client({ connectionString: SHADOW_URL, connectionTimeoutMillis: 1_500 });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    return false;
  }
}

let available = false;

beforeAll(async () => {
  await ensureMigrated();
  available = await shadowReachable();
  if (!available) {
    console.log(
      '\n  Skipping the shadow tests: no shadow database on 54330.' +
        '\n  `pnpm shadow:up && pnpm shadow:migrate` starts one.\n',
    );
  }
});

afterAll(async () => {
  delete process.env['SHADOW_DATABASE_URL'];
  resetDbEnvCache();
  await closePools();
});

/** Points the db package at a shadow, or at nothing. */
function useShadow(url: string | null): void {
  if (url === null) delete process.env['SHADOW_DATABASE_URL'];
  else process.env['SHADOW_DATABASE_URL'] = url;
  resetDbEnvCache();
  resetShadowStats();
}

/** Empties the shadow, so a run's reconciliation is about that run. */
async function truncateShadow(): Promise<void> {
  const client = new pg.Client({ connectionString: SHADOW_URL });
  await client.connect();
  try {
    await client.query('DELETE FROM events');
    await client.query('DELETE FROM end_users');
    await client.query('DELETE FROM sessions');
    await client.query('DELETE FROM accounts');
    await client.query("DELETE FROM projects WHERE mode = 'test'");
    await client.query('DELETE FROM projects');
  } finally {
    await client.end();
  }
}

describe('the shadow copy', () => {
  beforeEach(async () => {
    await resetData();
    if (available) await truncateShadow();
  });

  it('reconciles with zero gaps after a simulator run', async () => {
    // M13 exit check.
    if (!available) return;
    useShadow(SHADOW_URL);
    expect(shadowConfigured()).toBe(true);

    const definition = product('selfserve');
    const created = await createProject({ name: 'Shadowed', settings: {} });
    await withoutProject('worker-sweep', async (db) => {
      void db;
    });
    const { withProject } = await import('@dripmetric/db');
    await withProject(created.live.id, (db) => configureProject(db, definition));
    const keys = keysOf(created);

    /*
     * The project row has to exist in the shadow before its events can.
     *
     * `events.project_id` references `projects`, and the shadow carries the same
     * foreign keys — it has to, since the point of it is being restorable. In
     * production the project is copied when it is created; here it is done by hand
     * because the test creates one directly.
     */
    const client = new pg.Client({ connectionString: SHADOW_URL });
    await client.connect();
    try {
      for (const id of [created.live.id, created.test.id]) {
        const row = await withProject(id, (db) =>
          db.one<Record<string, unknown>>(
            `SELECT id, public_id, name, plan_code, timezone, mode, live_project_id,
                    settings, masking_secret, masking_secret_key_id, claimed_at, created_at
               FROM projects WHERE id = $1`,
            [db.projectId],
          ),
        );
        const columns = Object.keys(row);
        await client.query(
          `INSERT INTO projects (${columns.join(', ')})
           VALUES (${columns.map((_c, i) => `$${i + 1}`).join(', ')})
           ON CONFLICT (id) DO NOTHING`,
          columns.map((column) => row[column]),
        );
      }
    } finally {
      await client.end();
    }

    // A real run through the real API.
    const run = runSimulation({ product: 'selfserve', users: 20, seed: 13 });
    const receivedAt = new Date(run.truthFile.endedAt);
    const serverSide = run.messages.filter((message) => message.serverSide).slice(0, 120);

    const copied: string[] = [];
    const response = await handleBatch(
      {
        body: JSON.stringify({ batch: serverSide.map((message) => message.message) }),
        headers: { authorization: `Bearer ${keys.secret}`, 'content-type': 'application/json' },
        receivedAt,
      },
      {
        // The queue, inline: this is what the worker would receive.
        enqueueShadowCopy: (_projectId, hashes) => {
          copied.push(...hashes);
          return Promise.resolve();
        },
      },
    );
    expect(response.status).toBe(200);
    expect(copied.length).toBeGreaterThan(50);

    // The worker's half.
    const result = await withoutProject(
      'worker-sweep',
      (db) =>
        copyBatchToShadow((sql, params) => db.query<Record<string, unknown>>(sql, params), {
          projectId: created.live.id,
          messageHashes: copied,
        }),
      { worker: true },
    );
    expect(result.skippedBecause).toBeNull();
    /*
     * Fewer rows than queued hashes, and that is correct.
     *
     * `identify` and `group` messages are accepted and create no event row, so the
     * hashes queued for copying outnumber the events that exist. Asserting equality
     * was my own wrong expectation; what matters is that every event row made it,
     * which the reconciliation below checks against the primary's own count.
     */
    expect(result.copied).toBeGreaterThan(50);
    expect(result.copied).toBeLessThanOrEqual(copied.length);

    const reconciliation = await reconcile(receivedAt);
    expect(reconciliation.ran).toBe(true);

    // Zero gaps on events and the people they point at.
    const events = reconciliation.gaps.find((gap) => gap.table === 'events');
    const people = reconciliation.gaps.find((gap) => gap.table === 'end_users');
    expect(events?.primary).toBeGreaterThan(50);
    expect(events?.missing).toBe(0);
    expect(people?.primary).toBeGreaterThan(0);
    expect(people?.missing).toBe(0);
  }, 180_000);

  it('does not slow ingest when the shadow is killed', async () => {
    // M13 exit check, measured rather than asserted by inspection.
    if (!available) return;

    const definition = product('selfserve');
    const created = await createProject({ name: 'Unshadowed', settings: {} });
    const { withProject } = await import('@dripmetric/db');
    await withProject(created.live.id, (db) => configureProject(db, definition));
    const keys = keysOf(created);

    const run = runSimulation({ product: 'selfserve', users: 10, seed: 17 });
    const receivedAt = new Date(run.truthFile.endedAt);
    const batch = run.messages.filter((message) => message.serverSide).slice(0, 60);

    const send = async (label: string): Promise<number> => {
      const started = Date.now();
      const response = await handleBatch(
        {
          body: JSON.stringify({
            batch: batch.map((message, index) => ({
              ...message.message,
              // Fresh ids per run, or the second send is all duplicates and faster
              // for the wrong reason.
              messageId: `${label}_${index}`,
            })),
          }),
          headers: { authorization: `Bearer ${keys.secret}`, 'content-type': 'application/json' },
          receivedAt,
        },
        { enqueueShadowCopy: () => Promise.resolve() },
      );
      expect(response.status).toBe(200);
      return Date.now() - started;
    };

    useShadow(SHADOW_URL);
    const withLiveShadow = await send('live');

    /*
     * Pointed at a port with nothing behind it.
     *
     * A connection to 54399 does not answer, which is the worst case for ingest: not
     * a slow query but a hanging connect. If the request path touched the shadow at
     * all, this is where it would stall.
     */
    useShadow(DEAD_SHADOW_URL);
    const withDeadShadow = await send('dead');

    useShadow(null);
    const withNoShadow = await send('none');

    /*
     * The real assertion: the dead shadow is not slower than no shadow.
     *
     * Allowed a generous margin because these are 60-event batches on a shared
     * machine and the numbers move. What would fail is the thing worth catching: a
     * 2-second connect timeout per batch, which is 30x this margin.
     */
    const margin = Math.max(400, withNoShadow * 2);
    expect(withDeadShadow).toBeLessThan(withNoShadow + margin);
    expect(withLiveShadow).toBeLessThan(withNoShadow + margin);

    // And nothing was attempted from the request path, which is why.
    expect(shadowStats().attempted).toBe(0);
  }, 180_000);

  it('records a dead shadow as a skipped copy, not as an error', async () => {
    if (!available) return;
    useShadow(DEAD_SHADOW_URL);

    const result = await withoutProject(
      'worker-sweep',
      (db) =>
        copyBatchToShadow((sql, params) => db.query<Record<string, unknown>>(sql, params), {
          projectId: 1,
          messageHashes: ['00000000-0000-4000-8000-000000000001'],
        }),
      { worker: true },
    );

    // No throw: a dead shadow degrades to a counter and a log line.
    expect(result.copied).toBe(0);
    expect(result.skippedBecause).toBeNull();
  }, 60_000);

  it('reports an unreachable shadow rather than claiming a clean reconciliation', async () => {
    if (!available) return;
    useShadow(DEAD_SHADOW_URL);

    const result = await reconcile(new Date());
    // The dangerous answer would be `clean: true` because nothing disagreed.
    expect(result.ran).toBe(false);
    expect(result.clean).toBe(false);
    expect(result.why).toContain('did not answer');
  }, 60_000);

  it('does nothing at all when no shadow is configured', async () => {
    useShadow(null);
    expect(shadowConfigured()).toBe(false);

    const result = await reconcile(new Date());
    expect(result.ran).toBe(false);
    expect(result.why).toContain('No shadow');
    // Not a failure: no shadow is a supported state.
    expect(result.clean).toBe(true);
  });
});

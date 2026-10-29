import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { closePools, createProject, withProject, type CreatedProject } from '@dripmetric/db';
import { loadRootEnv, runMigrations } from '@dripmetric/db/admin';
import {
  leakSummary,
  refreshIntentState,
  refreshLifecycle,
  runFunnelDaily,
  sweepStepCollapse,
  sweepUserLeaks,
} from '@dripmetric/ingest';
import { runSimulation } from '../run.js';
import { configureProject } from '../setup.js';
import { product } from '../products/index.js';
import { keysOf, sendRun } from './send.js';
import { share } from '../score.js';
import type { TruthFile } from '../types.js';

/*
 * 20 minutes, not 10.
 *
 * This hook replays weeks of simulated history through the real ingest pipeline in
 * small time-local batches (send.ts says why they cannot be packed), which is about
 * 69,000 SQL round trips and ~8,900 transactions. It takes ~60s against a local
 * Postgres and is round-trip bound — 72% of that is the process waiting — so a
 * runner with slower round trips scales it by a lot more than its CPU would suggest.
 * CI timed out at 10 minutes on a hook that passes here in one.
 *
 * The headroom is the honest fix: the work is real, not accidental. Cutting the
 * round trips belongs in M13's load test, where ingest performance is the subject.
 */
const SIM_LOAD_TIMEOUT_MS = 1_200_000;

/**
 * M8 exit check (brief §11): "the simulator report prints the share of stalled users
 * caught."
 *
 * The truth file marks which personas are MEANT to be caught as a stall
 * (`expectStallLeak`) and which step they stalled on, so this is scored against a
 * known answer. Brief §10 asks for at least 90%.
 */

let migrated = false;

async function ensureMigrated(): Promise<void> {
  if (migrated) return;
  loadRootEnv();
  const client = new pg.Client({ connectionString: process.env['ADMIN_DATABASE_URL'] });
  await client.connect();
  try {
    await runMigrations(client);
    await client.query(`ALTER ROLE dripmetric_app LOGIN PASSWORD 'dripmetric_app'`);
  } finally {
    await client.end();
  }
  migrated = true;
}

async function resetData(): Promise<void> {
  const client = new pg.Client({ connectionString: process.env['ADMIN_DATABASE_URL'] });
  await client.connect();
  try {
    await client.query("SET lock_timeout = '10s'");
    for (const table of [
      'leak_instances',
      'intent_state',
      'intent_config',
      'daily_summaries',
      'retention_cohorts',
      'step_segment_daily',
      'step_daily',
      'step_hourly',
      'step_thresholds',
      'changes',
      'user_step_sessions',
      'events',
      'user_step_state',
      'daily_event_counts',
      'monthly_active_users',
      'rate_buckets',
      'anonymous_links',
      'anonymous_visitors',
      'account_members',
      'sessions',
      'funnel_steps',
      'funnels',
      'url_rules',
      'paths',
      'event_name_properties',
      'event_names',
      'recompute_runs',
      'product_facts',
      'audit_log',
      'api_keys',
      'project_members',
      'magic_link_tokens',
      'founder_sessions',
      'founder_users',
    ]) {
      await client.query(`DELETE FROM ${table}`);
    }
    await client.query('UPDATE end_users SET account_id = NULL');
    await client.query('DELETE FROM accounts');
    await client.query('DELETE FROM end_users');
    await client.query("DELETE FROM projects WHERE mode = 'test'");
    await client.query('DELETE FROM projects');
  } finally {
    await client.end();
  }
}

interface Loaded {
  created: CreatedProject;
  truthFile: TruthFile;
  now: Date;
}

describe('the leak engine against the truth file', () => {
  let loaded: Loaded;

  beforeAll(async () => {
    await ensureMigrated();
    await resetData();

    const definition = product('selfserve');
    const created = await createProject({
      name: 'Leaks',
      settings: {
        internalDomains: ['ledgerly-internal.com'],
        listPriceAmount: definition.listPriceAmount,
        listPriceCurrency: definition.listPriceCurrency,
        trialDays: definition.trialDays,
      },
    });
    await withProject(created.live.id, (db) => configureProject(db, definition));

    const run = runSimulation({ product: 'selfserve', users: 250, seed: 5 });
    await sendRun(run.messages, keysOf(created));

    const now = new Date(run.truthFile.endedAt);
    await withProject(created.live.id, refreshLifecycle);
    // The stall bar is a step's own 90th percentile once 20 people have finished it,
    // and that is M6's job: the leak engine reads what it stored.
    await runFunnelDaily(created.live.id, now);
    await withProject(created.live.id, (db) => refreshIntentState(db, now));
    await withProject(created.live.id, (db) => sweepUserLeaks(db, now));
    await withProject(created.live.id, (db) => sweepStepCollapse(db, now));

    loaded = { created, truthFile: run.truthFile, now };
  }, SIM_LOAD_TIMEOUT_MS);
  afterAll(closePools);

  it('catches the people the truth file says stalled, and prints the share', async () => {
    const shouldStall = loaded.truthFile.truth.filter(
      (t) => !t.expectFiltered && t.expectStallLeak && t.stalledAtStep !== null,
    );
    expect(shouldStall.length).toBeGreaterThan(20);

    const caught = await withProject(loaded.created.live.id, (db) =>
      db.query<{ external_id: string }>(
        `SELECT DISTINCT u.external_id
           FROM leak_instances l
           JOIN end_users u ON u.project_id = l.project_id AND u.user_key = l.subject_key
          WHERE l.project_id = $1 AND l.leak_type = 'onboarding-stall'`,
        [db.projectId],
      ),
    );
    const caughtIds = new Set(caught.map((row) => row.external_id));
    const found = shouldStall.filter((t) => caughtIds.has(t.userId)).length;
    const recall = share(found, shouldStall.length);

    // The brief asks for this to be printed (brief §10, §11).
    console.log(
      `  stalls: ${found} of ${shouldStall.length} users the truth file says stalled were caught  ${recall.toFixed(1)}%`,
    );

    expect(recall).toBeGreaterThanOrEqual(90);
  }, 300_000);

  it('never fires a leak about someone who paid, was deleted or opted out', async () => {
    const wrong = await withProject(loaded.created.live.id, (db) =>
      db.query<{ leak_type: string; external_id: string }>(
        `SELECT l.leak_type, u.external_id
           FROM leak_instances l
           JOIN end_users u ON u.project_id = l.project_id AND u.user_key = l.subject_key
          WHERE l.project_id = $1
            AND l.subject_kind = 'user'
            AND (u.deleted_at IS NOT NULL OR u.opted_out
                 OR (u.paid_at IS NOT NULL
                     AND l.leak_type IN ('last-moment-drop', 'high-intent-quiet',
                                         'trial-ended-unpaid', 'limit-reached-no-upgrade',
                                         'onboarding-stall', 'pricing-quick-exit')))`,
        [db.projectId],
      ),
    );
    expect(wrong).toEqual([]);

    // And there ARE payers in this run, so the check is not passing by emptiness.
    const payers = await withProject(loaded.created.live.id, (db) =>
      db.one<{ count: string }>(
        `SELECT count(*)::text AS count FROM end_users
          WHERE project_id = $1 AND paid_at IS NOT NULL`,
        [db.projectId],
      ),
    );
    expect(Number(payers.count)).toBeGreaterThan(10);
  }, 300_000);

  it('records at most one row per person per leak per episode', async () => {
    const duplicates = await withProject(loaded.created.live.id, (db) =>
      db.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM leak_instances
          WHERE project_id = $1
          GROUP BY subject_kind, subject_key, leak_type, episode_key
         HAVING count(*) > 1`,
        [db.projectId],
      ),
    );
    expect(duplicates).toEqual([]);
  }, 300_000);

  it('is idempotent: sweeping again records nothing new', async () => {
    const before = await withProject(loaded.created.live.id, (db) =>
      db.one<{ count: string }>(`SELECT count(*)::text AS count FROM leak_instances`),
    );

    const again = await withProject(loaded.created.live.id, (db) => sweepUserLeaks(db, loaded.now));

    const after = await withProject(loaded.created.live.id, (db) =>
      db.one<{ count: string }>(`SELECT count(*)::text AS count FROM leak_instances`),
    );

    // The rules found the same leaks again, and the index refused them again.
    expect(again.found).toBeGreaterThan(0);
    expect(again.recorded).toBe(0);
    expect(after.count).toBe(before.count);
  }, 300_000);

  it('summarises every leak with its rule and a money figure that shows its formula', async () => {
    const summary = await withProject(loaded.created.live.id, (db) => leakSummary(db, loaded.now));

    expect(summary.totalOpen).toBeGreaterThan(0);
    expect(summary.byType.length).toBeGreaterThan(1);

    for (const entry of summary.byType) {
      expect(entry.rule.length, entry.type).toBeGreaterThan(30);
      if (entry.type === 'step-collapse') {
        // A leak about a step is not about people, so it has no money figure.
        expect(entry.potentialRevenue).toBeNull();
      } else {
        expect(entry.potentialRevenue, entry.type).not.toBeNull();
        expect(entry.potentialRevenue!.formula).toContain('19.00 USD');
      }
    }

    console.log('  leaks found:');
    for (const entry of summary.byType) {
      console.log(
        `    ${entry.type.padEnd(26)} ${String(entry.open).padStart(4)} open  ${entry.potentialRevenue?.formula ?? '(not about people)'}`,
      );
    }
  }, 300_000);

  it('reports the quick-exit rate split four ways', async () => {
    const summary = await withProject(loaded.created.live.id, (db) => leakSummary(db, loaded.now));
    const { quickExit } = summary;

    expect(quickExit.views).toBeGreaterThan(0);
    expect(quickExit.overall).not.toBeNull();
    expect(quickExit.overall!).toBeGreaterThanOrEqual(0);
    expect(quickExit.overall!).toBeLessThanOrEqual(1);
    // Brief §8.3: "a rate by source, device, country and trial day".
    expect(quickExit.bySource.length).toBeGreaterThan(0);
    expect(quickExit.byDevice.length).toBeGreaterThan(0);
    expect(quickExit.byCountry.length).toBeGreaterThan(0);
    expect(quickExit.byTrialDay.length).toBeGreaterThan(0);

    console.log(
      `  pricing quick exit: ${quickExit.exits} of ${quickExit.views} first views  ${((quickExit.overall ?? 0) * 100).toFixed(1)}%`,
    );
    for (const row of quickExit.byDevice) {
      console.log(`    ${row.value.padEnd(10)} ${row.exits}/${row.views}`);
    }
  }, 300_000);
});

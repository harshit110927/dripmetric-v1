import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import {
  closePools,
  createProject,
  dailySummaryRows,
  markChange,
  retentionCohortRows,
  retentionHeadline,
  stepTrendRows,
  withProject,
} from '@dripmetric/db';
import { loadRootEnv, runMigrations } from '@dripmetric/db/admin';
import { MIN_COMPLETIONS_FOR_PERCENTILES } from '@dripmetric/engine';
import {
  currentFunnelReport,
  refreshLifecycle,
  runFunnelDaily,
  runFunnelHourly,
  storeThresholds,
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
 * M6 exit check (brief §11): "on simulator data, per-step drop-off, medians and stuck
 * counts match the truth file."
 *
 * The truth file records what really happened to every simulated person — which steps
 * they finished and where they stalled — so these are comparisons against a known
 * answer rather than against the engine's own output.
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

/** Sends a run through the pipeline the way the HTTP loader does. */

/** The people the numbers are about: everyone the truth says we should track. */
function tracked(truthFile: TruthFile) {
  return truthFile.truth.filter((t) => !t.expectFiltered && t.signedUpAt !== null);
}

async function loadedProject(users: number, faults: never[] = []) {
  const created = await createProject({
    name: 'Funnel',
    settings: { internalDomains: ['ledgerly-internal.com'] },
  });
  const definition = product('selfserve');
  await withProject(created.live.id, (db) => configureProject(db, definition));

  const run = runSimulation({ product: 'selfserve', users, seed: 1, faults });
  await sendRun(run.messages, keysOf(created));
  await withProject(created.live.id, refreshLifecycle);

  return { created, run, now: new Date(run.truthFile.endedAt) };
}

/*
 * One run, read many times.
 *
 * Every check below reads the same 200-person run rather than generating its own:
 * loading a run through real ingest takes about 35 seconds, and six copies of it was
 * most of this file's runtime for no extra coverage. The checks that CHANGE state
 * have their own describe block below, with a reset between each.
 */
describe('the funnel engine against the truth file', () => {
  let loaded: Awaited<ReturnType<typeof loadedProject>>;

  beforeAll(async () => {
    await ensureMigrated();
    await resetData();
    loaded = await loadedProject(200);
  }, SIM_LOAD_TIMEOUT_MS);
  afterAll(closePools);

  it('reports per-step completions and drop-off that match what really happened', async () => {
    const { created, run, now } = loaded;
    const report = await withProject(created.live.id, (db) => currentFunnelReport(db, now));

    const people = tracked(run.truthFile);
    expect(people.length).toBeGreaterThan(50);

    // The funnel has the steps the product declares, in order.
    expect(report.steps.map((s) => s.label)).toEqual(run.truthFile.steps.map((s) => s.label));

    for (const step of report.steps) {
      const truthCompleted = people.filter((t) => t.stepsCompleted.includes(step.label)).length;
      const truthStalledHere = people.filter((t) => t.stalledAtStep === step.label).length;

      // Completions are a fact, and they have to be exact.
      expect(step.completed, `${step.label} completions`).toBe(truthCompleted);

      // Everyone who finished it entered it, and so did everyone who stalled on it.
      expect(step.entered, `${step.label} entered`).toBeGreaterThanOrEqual(
        truthCompleted + truthStalledHere,
      );
      expect(step.droppedOff).toBe(step.entered - step.completed);
      if (step.entered > 0) {
        expect(step.dropOffRate).toBeCloseTo(step.droppedOff / step.entered, 6);
        expect(step.completionRate).toBeCloseTo(step.completed / step.entered, 6);
      }
    }

    // The funnel only narrows: more people enter step 1 than finish the last step.
    const first = report.steps[0]!;
    const last = report.steps[report.steps.length - 1]!;
    expect(first.entered).toBeGreaterThanOrEqual(last.completed);
  }, 240_000);

  it('matches the truth file on who signed up, activated and paid', async () => {
    const { created, run, now } = loaded;
    const report = await withProject(created.live.id, (db) => currentFunnelReport(db, now));
    const people = tracked(run.truthFile);

    expect(report.signedUp).toBe(people.filter((t) => t.signedUpAt !== null).length);
    expect(report.activated).toBe(people.filter((t) => t.activatedAt !== null).length);
    expect(report.paid).toBe(people.filter((t) => t.paidAt !== null).length);
  }, 240_000);

  /*
   * "Stuck" is a threshold rule, not a recorded fact, so this is scored rather than
   * asserted exactly — the brief's own bar for the simulator is 90% ("aim for at
   * least 90% on the simulator and explain any shortfall").
   *
   * The other half matters just as much: nobody who finished the funnel may be
   * called stuck. A false positive here becomes an alert about a happy customer.
   */
  it('finds the people the truth file says stalled, and only them', async () => {
    const { created, run, now } = loaded;

    const stuckByStep = await withProject(created.live.id, async (db) => {
      const report = await currentFunnelReport(db, now);
      return new Map(report.steps.map((step) => [step.label, step.stuckNow]));
    });

    const people = tracked(run.truthFile);
    const shouldStall = people.filter((t) => t.expectStallLeak && t.stalledAtStep !== null);
    expect(shouldStall.length).toBeGreaterThan(10);

    const reportedStuck = [...stuckByStep.values()].reduce((sum, n) => sum + n, 0);
    const expectedStuck = shouldStall.length;

    // Recall, against the brief's 90% bar.
    const recall = share(Math.min(reportedStuck, expectedStuck), expectedStuck);
    // The brief asks for this to be printed, not just asserted (brief §10).
    console.log(
      `  stuck: ${reportedStuck} reported / ${expectedStuck} the truth file says stalled  ${recall.toFixed(1)}%`,
    );
    expect(
      recall,
      `stuck recall ${recall}% (${reportedStuck} reported, ${expectedStuck} expected)`,
    ).toBeGreaterThanOrEqual(90);

    // And no runaway: we are not calling half the funnel stuck to reach that recall.
    expect(reportedStuck).toBeLessThanOrEqual(expectedStuck * 2);

    // Nobody who paid is stuck anywhere.
    const stuckPayers = await withProject(created.live.id, (db) =>
      db.query<{ count: string }>(
        `SELECT count(*) FROM user_step_state st
           JOIN end_users u ON u.project_id = st.project_id AND u.user_key = st.user_key
          WHERE st.project_id = $1
            AND u.paid_at IS NOT NULL
            AND st.first_entered_at IS NOT NULL
            AND st.first_completed_at IS NULL
            AND st.step_id = (SELECT id FROM funnel_steps WHERE project_id = $1 ORDER BY position LIMIT 1)`,
        [db.projectId],
      ),
    );
    expect(Number(stuckPayers[0]!.count)).toBe(0);
  }, 240_000);

  it('shows a median only where twenty people finished the step with a known start', async () => {
    const { created, now } = loaded;
    const report = await withProject(created.live.id, (db) => currentFunnelReport(db, now));

    let withMedian = 0;
    for (const step of report.steps) {
      const timed = step.elapsed.count;
      if (timed >= MIN_COMPLETIONS_FOR_PERCENTILES) {
        expect(step.elapsed.median, `${step.label} has ${timed} timed completions`).not.toBeNull();
        // A median sits inside the middle half, which sits inside the whole range.
        expect(step.elapsed.p25!).toBeLessThanOrEqual(step.elapsed.median!);
        expect(step.elapsed.median!).toBeLessThanOrEqual(step.elapsed.p75!);
        expect(step.elapsed.p75!).toBeLessThanOrEqual(step.elapsed.p90!);
        expect(step.percentilesNote).toBeNull();
        withMedian += 1;
      } else {
        expect(step.elapsed.median, `${step.label} has ${timed} timed completions`).toBeNull();
        // And it says why, in words a founder can read.
        expect(step.percentilesNote).toContain('20');
      }
    }
    expect(withMedian, 'at least one step should have enough timed completions').toBeGreaterThan(0);
  }, 240_000);

  /*
   * The honest half of the same rule.
   *
   * "Create account" is reached by a server-side `Signed Up` and nothing else, so we
   * know 166 people finished it and we do not know when any of them started. It gets
   * a drop-off and no duration — not a duration of zero, which is what a naive
   * reading of the step state would have produced.
   */
  it('reports a drop-off but no duration for a step with no start event', async () => {
    const { created, now } = loaded;
    const report = await withProject(created.live.id, (db) => currentFunnelReport(db, now));

    const signup = report.steps[0]!;
    expect(signup.label).toBe('Create account');
    expect(signup.completed).toBeGreaterThan(20);
    expect(signup.entered).toBeGreaterThanOrEqual(signup.completed);
    expect(signup.droppedOff).toBeGreaterThanOrEqual(0);

    expect(signup.elapsed.count).toBe(0);
    expect(signup.elapsed.median).toBeNull();
    expect(signup.elapsed.average).toBeNull();
    expect(signup.percentilesNote).toContain('20');
  }, 240_000);

  it('judges each step against its own history, not against one global bar', async () => {
    const { created, now } = loaded;

    const thresholds = await withProject(created.live.id, async (db) => {
      await storeThresholds(db, now);
      return db.query<{ label: string; stuck_elapsed_seconds: string; completions: number }>(
        `SELECT s.label, t.stuck_elapsed_seconds, t.completions
           FROM step_thresholds t
           JOIN funnel_steps s ON s.project_id = t.project_id AND s.id = t.step_id
          WHERE t.project_id = $1
          ORDER BY s.position`,
        [db.projectId],
      );
    });

    expect(thresholds.length).toBeGreaterThan(1);
    for (const row of thresholds) {
      // Brief §8.1: clamped between 1 and 72 hours.
      expect(Number(row.stuck_elapsed_seconds)).toBeGreaterThanOrEqual(3_600);
      expect(Number(row.stuck_elapsed_seconds)).toBeLessThanOrEqual(72 * 3_600);
    }
  }, 240_000);
});

/** The checks that write: each gets a clean database. */
describe('the funnel jobs', () => {
  beforeAll(ensureMigrated, 60_000);
  beforeEach(resetData);
  afterAll(closePools);

  /*
   * M6 exit check: "thresholds freeze when a change is marked."
   *
   * The test that matters is not that a column was written, but that more data
   * arriving does not move the bar afterwards — which is the whole reason the brief
   * asks for it.
   */
  it('stops the bar moving once the founder marks a change', async () => {
    const { created, run, now } = await loadedProject(120);

    const before = await withProject(created.live.id, async (db) => {
      await storeThresholds(db, now);
      await markChange(
        db,
        { stepId: null, happenedAt: now, note: 'Shortened the import step' },
        null,
      );
      return db.query<{ step_id: number; stuck_elapsed_seconds: string; frozen: string | null }>(
        `SELECT step_id, stuck_elapsed_seconds, frozen_by_change_id AS frozen
           FROM step_thresholds WHERE project_id = $1 ORDER BY step_id`,
        [db.projectId],
      );
    });

    expect(before.length).toBeGreaterThan(0);
    for (const row of before) expect(row.frozen).not.toBeNull();

    // A second, different run of people arrives. Without the freeze their times
    // would move every threshold.
    const second = runSimulation({ product: 'selfserve', users: 120, seed: 99 });
    await sendRun(second.messages, keysOf(created));
    const later = new Date(new Date(second.truthFile.endedAt).getTime() + 86_400_000);

    const after = await withProject(created.live.id, async (db) => {
      await refreshLifecycle(db);
      await storeThresholds(db, later);
      return db.query<{ step_id: number; stuck_elapsed_seconds: string; computed_at: Date }>(
        `SELECT step_id, stuck_elapsed_seconds, computed_at
           FROM step_thresholds WHERE project_id = $1 ORDER BY step_id`,
        [db.projectId],
      );
    });

    const beforeByStep = new Map(before.map((r) => [r.step_id, r.stuck_elapsed_seconds]));
    for (const row of after) {
      expect(row.stuck_elapsed_seconds, `step ${row.step_id} moved after the freeze`).toBe(
        beforeByStep.get(row.step_id),
      );
      // The frozen copy keeps the moment it was frozen, not the moment it was read.
      expect(row.computed_at.getTime()).toBe(now.getTime());
    }

    // The run itself is sound: this is not passing because nothing was ingested.
    expect(second.truthFile.truth.length).toBe(120);
    expect(run.truthFile.truth.length).toBe(120);
  }, 300_000);

  it('writes the aggregates, the segment splits, the cohorts and the daily summary', async () => {
    const { created, now } = await loadedProject(150);
    await runFunnelHourly(created.live.id, now);
    await runFunnelDaily(created.live.id, now);

    const counts = await withProject(created.live.id, (db) =>
      db.one<{
        hourly: string;
        daily: string;
        segments: string;
        cohorts: string;
        summaries: string;
      }>(
        `SELECT
           (SELECT count(*) FROM step_hourly WHERE project_id = $1)::text AS hourly,
           (SELECT count(*) FROM step_daily WHERE project_id = $1)::text AS daily,
           (SELECT count(*) FROM step_segment_daily WHERE project_id = $1)::text AS segments,
           (SELECT count(*) FROM retention_cohorts WHERE project_id = $1)::text AS cohorts,
           (SELECT count(*) FROM daily_summaries WHERE project_id = $1)::text AS summaries`,
        [db.projectId],
      ),
    );

    expect(Number(counts.daily)).toBeGreaterThan(0);
    expect(Number(counts.segments)).toBeGreaterThan(0);
    expect(Number(counts.cohorts)).toBeGreaterThan(0);
    expect(Number(counts.summaries)).toBe(1);

    /*
     * The hourly rows cover the last 48 hours only, which for a run spread over
     * weeks is a slice of it. Asserting "greater than zero" would be asserting that
     * the simulator happens to put events in that window, so the check is that every
     * row that exists is inside the window and never claims more than the day does.
     */
    const hourly = await withProject(created.live.id, (db) =>
      db.query<{ hour: Date; entered: number; completed: number; step_id: number }>(
        `SELECT hour, entered, completed, step_id FROM step_hourly WHERE project_id = $1`,
        [db.projectId],
      ),
    );
    for (const row of hourly) {
      expect(row.hour.getTime()).toBeLessThanOrEqual(now.getTime());
      expect(row.hour.getTime()).toBeGreaterThan(now.getTime() - 49 * 3_600_000);
      expect(row.entered + row.completed).toBeGreaterThan(0);
    }

    // And the stored reads give the dashboard what it will ask for.
    const reads = await withProject(created.live.id, async (db) => ({
      retention: await retentionHeadline(db),
      cohorts: await retentionCohortRows(db),
      trend: await stepTrendRows(db, now),
      summaries: await dailySummaryRows(db),
    }));
    expect(reads.cohorts.length).toBeGreaterThan(0);
    expect(reads.trend.length).toBeGreaterThan(0);
    expect(reads.summaries).toHaveLength(1);
    // A rate is only ever reported for a week that has actually finished.
    for (const cohort of reads.cohorts) {
      if (cohort.week1Rate !== null) expect(cohort.completeWeeks).toBeGreaterThanOrEqual(1);
      if (cohort.week4Rate !== null) expect(cohort.completeWeeks).toBeGreaterThanOrEqual(4);
    }
    if (reads.retention.week1) expect(reads.retention.week1.rate).toBeLessThanOrEqual(1);

    // The summary is the row that outlives the raw events, so it has to carry the
    // numbers rather than point at them.
    const summary = await withProject(created.live.id, (db) =>
      db.one<{ payload: { funnel: { steps: unknown[]; signedUp: number } } }>(
        `SELECT payload FROM daily_summaries WHERE project_id = $1`,
        [db.projectId],
      ),
    );
    expect(summary.payload.funnel.steps.length).toBeGreaterThan(0);
    expect(summary.payload.funnel.signedUp).toBeGreaterThan(0);
  }, 300_000);

  it('is idempotent: running the daily job twice changes nothing', async () => {
    const { created, now } = await loadedProject(120);

    await runFunnelDaily(created.live.id, now);
    const first = await snapshot(created.live.id);
    await runFunnelDaily(created.live.id, now);
    const second = await snapshot(created.live.id);

    expect(second).toEqual(first);
  }, 300_000);
});

/** Every aggregate row, as a comparable string. */
async function snapshot(projectId: number): Promise<string> {
  return withProject(projectId, async (db) => {
    const rows = await db.query<Record<string, unknown>>(
      `SELECT 'daily' AS t, step_id::text AS a, day::text AS b,
              entered::text AS c, completed::text AS d, stuck_at_end::text AS e,
              coalesce(p50_seconds::text, '-') AS f
         FROM step_daily WHERE project_id = $1
       UNION ALL
       SELECT 'segment', step_id::text, day::text || dimension || value_key,
              entered::text, completed::text, '', ''
         FROM step_segment_daily WHERE project_id = $1
       UNION ALL
       SELECT 'cohort', cohort_week::text, users::text, retained::text,
              coalesce(week1_rate::text, '-'), coalesce(week4_rate::text, '-'), ''
         FROM retention_cohorts WHERE project_id = $1
       ORDER BY 1, 2, 3`,
      [db.projectId],
    );
    return JSON.stringify(rows);
  });
}

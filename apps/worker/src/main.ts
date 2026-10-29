import { closePools, withoutProject } from '@dripmetric/db';
import { loadRootEnv } from '@dripmetric/db/admin';
import {
  pendingRecomputeProjects,
  recomputeChunk,
  runFunnelDaily,
  runFunnelHourly,
} from '@dripmetric/ingest';
import { projectsWithFunnels } from '@dripmetric/db';
import { QUEUE_POLICIES, QUEUES, startQueue, type Queue } from './queue.js';
import { log } from './log.js';

/**
 * The always-on worker (settled decision D3). One process, pg-boss on the same
 * Postgres, behind the queue adapter.
 *
 * It declares its queues, reports queue health, and runs the jobs that exist:
 * `recompute` since M5. The sweeps, summaries, alerts and reports arrive with the
 * milestones that need them (M6 onwards); their queue names already exist, so
 * turning each on is a handler, not a change to this file.
 */

loadRootEnv();

const SWEEP_INTERVAL_SECONDS = 5 * 60; // brief section 8.3: sweeps every 5 minutes
const HEALTH_INTERVAL_SECONDS = 60;

/**
 * Chunks a single recompute job runs before handing the queue back.
 *
 * A run is resumable, so stopping early costs nothing: the next job picks up at the
 * cursor. The cap exists so one project with 13 months of events cannot hold the
 * queue while every other project's mapping change waits (brief §7).
 */
const RECOMPUTE_CHUNKS_PER_JOB = 20;

async function main(): Promise<void> {
  log.info('worker starting');
  const queue = await startQueue();

  for (const name of Object.values(QUEUES)) {
    await queue.ensure(name, QUEUE_POLICIES[name] ?? 'standard');
  }
  log.info('queues ready', { queues: Object.values(QUEUES) });

  // A round-trip handler, so M1 can prove the queue actually works end to end.
  await queue.work<{ projectId: number; userKey: number }>(QUEUES.recomputeIntent, async (jobs) => {
    log.debug('recompute-intent', { count: jobs.length });
    // The engine lands at M7. Until then this only proves delivery.
  });

  await queue.work(QUEUES.sweepLeaks, async () => {
    // M8. Every 5 minutes, over every project.
    log.debug('sweep-leaks tick');
  });

  /*
   * The recompute job (brief §7, CLAUDE.md rule 10).
   *
   * The web app queues a run by writing a row, so the sweep is what turns that row
   * into work. Confirming a mapping therefore rebuilds history without the request
   * path ever touching the queue.
   */
  await queue.work<{ projectId: number }>(QUEUES.recompute, async (jobs) => {
    for (const job of jobs) {
      await runRecompute(queue, job.data.projectId);
    }
  });

  await queue.work(QUEUES.recomputeSweep, async () => {
    const projects = await pendingRecomputeProjects();
    if (projects.length === 0) return;
    log.info('recompute waiting', { projects: projects.length });
    for (const projectId of projects) {
      await queue.send(
        QUEUES.recompute,
        { projectId },
        // The queue is `short`: a project already waiting is not queued twice.
        { singletonKey: `recompute:${projectId}` },
      );
    }
  });

  /*
   * The funnel jobs (brief §8.1, M6).
   *
   * Hourly: the hourly aggregates and the thresholds every screen judges a step by.
   * Nightly: the daily aggregates, the segment splits, the retention cohorts and the
   * daily summary, which is the row that outlives the raw events.
   */
  await queue.work<{ projectId: number }>(QUEUES.funnelHourly, async (jobs) => {
    for (const job of jobs) {
      await runFunnelHourly(job.data.projectId, new Date());
      log.debug('funnel hourly done', { projectId: job.data.projectId });
    }
  });

  await queue.work<{ projectId: number }>(QUEUES.dailySummaries, async (jobs) => {
    for (const job of jobs) {
      await runFunnelDaily(job.data.projectId, new Date());
      log.info('funnel daily done', { projectId: job.data.projectId });
    }
  });

  /*
   * Two sweeps rather than one with a flag, because a scheduled pg-boss job carries
   * no data of its own: the queue name is the only thing that can say which pass
   * this is.
   */
  await queue.work(QUEUES.funnelSweep, () => fanOut(queue, QUEUES.funnelHourly, 'hourly'));
  await queue.work(QUEUES.dailySummariesSweep, () => fanOut(queue, QUEUES.dailySummaries, 'daily'));

  // Every 5 minutes. Real cron with time zones arrives with the jobs that need them.
  await queue.schedule(QUEUES.sweepLeaks, '*/5 * * * *');
  // A few minutes past the hour, so a step entered at 09:59 is in the 09:00 bucket.
  await queue.schedule(QUEUES.funnelSweep, '7 * * * *');
  /*
   * The nightly pass runs at 02:11 UTC.
   *
   * Not on the hour and not at midnight: everyone's nightly job runs at midnight, and
   * a daily summary written while the day is still turning over somewhere is a day
   * boundary argument we do not need. Per-founder time zones arrive with the weekly
   * report, which is the job that actually has to respect them (brief §9).
   */
  await queue.schedule(QUEUES.dailySummariesSweep, '11 2 * * *');
  // Every minute: a founder who changes a mapping should not wait five.
  await queue.schedule(QUEUES.recomputeSweep, '* * * * *');

  const health = setInterval(() => {
    void reportHealth(queue);
  }, HEALTH_INTERVAL_SECONDS * 1000);
  health.unref();

  log.info('worker ready', { sweepIntervalSeconds: SWEEP_INTERVAL_SECONDS });

  const shutdown = async (signal: string) => {
    log.info('worker stopping', { signal });
    clearInterval(health);
    await queue
      .stop()
      .catch((error: unknown) => log.error('queue stop failed', { err: String(error) }));
    await closePools();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

/** Sends one job per project that has a funnel to aggregate. */
async function fanOut(queue: Queue, target: string, label: string): Promise<void> {
  const projects = await projectsWithFunnels();
  if (projects.length === 0) return;

  for (const projectId of projects) {
    await queue.send(target, { projectId }, { singletonKey: `${label}:${projectId}` });
  }
  log.info('funnel sweep', { pass: label, projects: projects.length });
}

/**
 * Drains one project's recompute, bounded.
 *
 * `now` is passed in from here rather than read inside the job, because the engine
 * and every job that calls it take time as a parameter (CLAUDE.md rule 9).
 */
async function runRecompute(queue: Queue, projectId: number): Promise<void> {
  const now = new Date();
  let chunks = 0;

  for (; chunks < RECOMPUTE_CHUNKS_PER_JOB; chunks++) {
    const progress = await recomputeChunk(projectId, now);
    if (progress === null) return; // nothing queued any more
    if (progress.done) {
      log.info('recompute done', { projectId, runId: progress.runId, events: progress.eventsSeen });
      return;
    }
  }

  // Still going: hand the queue back and come straight back to it.
  log.info('recompute continuing', { projectId, chunks });
  await queue.send(QUEUES.recompute, { projectId }, { singletonKey: `recompute:${projectId}` });
}

/** Queue depth, oldest job age and failure rate: the M13 metrics, wired from the start. */
async function reportHealth(queue: Queue): Promise<void> {
  try {
    const health = await queue.health();
    const busy = health.queues.filter((q) => q.pending > 0);
    if (busy.length > 0) log.info('queue health', { queues: busy });
  } catch (error) {
    log.error('queue health failed', { err: String(error) });
  }
}

/** A liveness check the dev script and M13's monitoring both use. */
export async function databaseReachable(): Promise<boolean> {
  try {
    await withoutProject('worker-sweep', (db) => db.query('SELECT 1'), { worker: true });
    return true;
  } catch {
    return false;
  }
}

main().catch((error: unknown) => {
  log.error('worker failed to start', { err: String(error) });
  process.exit(1);
});

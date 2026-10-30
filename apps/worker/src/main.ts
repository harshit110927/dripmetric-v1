import {
  closePools,
  describeReconciliation,
  reconcile,
  shadowConfigured,
  shadowStats,
  withoutProject,
} from '@dripmetric/db';
import { loadRootEnv } from '@dripmetric/db/admin';
import {
  copyBatchToShadow,
  runRetention,
  runTrackingHealth,
  sweepUnclaimedProjects,
  runAlertDispatch,
  runDailyDigest,
  runWeeklyReport,
  pendingRecomputeProjects,
  recomputeChunk,
  runCollapseSweep,
  runFunnelDaily,
  runFunnelHourly,
  runIntentDaily,
  runIntentRefresh,
  runLeakSweep,
  writeLeakSummary,
} from '@dripmetric/ingest';
import { activeProjects, projectsWithFunnels, withProject } from '@dripmetric/db';
import { QUEUE_POLICIES, QUEUES, startQueue, type Queue } from './queue.js';
import { sendSystemEmail } from './mailer.js';
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

  /*
   * The intent engine (brief §8.2, M7).
   *
   * One pass per project rather than one per person: the facts come from a single
   * query over the project's events, so a thousand per-person passes would be a
   * thousand copies of the same work. The per-person follow-up the ingest pipeline
   * already collects stays unconnected until a score has to be fresh within seconds.
   */
  await queue.work<{ projectId: number }>(QUEUES.recomputeIntent, async (jobs) => {
    for (const job of jobs) {
      const users = await runIntentRefresh(job.data.projectId, new Date());
      log.debug('intent refreshed', { projectId: job.data.projectId, users });
    }
  });

  /*
   * The leak sweeps (brief §8.3, M8).
   *
   * Every five minutes for the per-person leaks, hourly for the step-completion
   * collapse. Recording a finding is an insert that ignores conflicts, so running a
   * sweep more often than needed costs a query and changes nothing — which is what
   * makes these safe to retry.
   */
  await queue.work<{ projectId: number }>(QUEUES.sweepLeaks, async (jobs) => {
    for (const job of jobs) {
      const result = await runLeakSweep(job.data.projectId, new Date());
      if (result.recorded > 0) {
        log.info('leaks found', {
          projectId: job.data.projectId,
          recorded: result.recorded,
          byType: result.byType,
        });
      }
      // A leak that cannot run is worth saying out loud once a sweep, not never.
      for (const off of result.off) {
        log.debug('leak off', {
          projectId: job.data.projectId,
          leak: off.type,
          missing: off.missing,
        });
      }
    }
  });

  await queue.work<{ projectId: number }>(QUEUES.checkCollapse, async (jobs) => {
    for (const job of jobs) {
      const result = await runCollapseSweep(job.data.projectId, new Date());
      if (result.recorded > 0) {
        log.info('step collapse', { projectId: job.data.projectId, recorded: result.recorded });
      }
    }
  });

  await queue.work(QUEUES.leakSweepFanOut, () => fanOut(queue, QUEUES.sweepLeaks, 'leaks'));
  await queue.work(QUEUES.collapseFanOut, () => fanOut(queue, QUEUES.checkCollapse, 'collapse'));

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
      const now = new Date();
      await runFunnelDaily(job.data.projectId, now);
      const calibration = await runIntentDaily(job.data.projectId, now);
      // The leak section of the daily summary, beside the funnel's and intent's.
      await withProject(job.data.projectId, (db) => writeLeakSummary(db, now), { worker: true });
      log.info('daily done', {
        projectId: job.data.projectId,
        calibrationReady: calibration.ready,
        payers: calibration.payers,
      });
      // The brief asks for the calibration report to be printed (brief §8.2, §11).
      if (calibration.ready) for (const line of calibration.lines) log.info(line);
    }
  });

  /*
   * Two sweeps rather than one with a flag, because a scheduled pg-boss job carries
   * no data of its own: the queue name is the only thing that can say which pass
   * this is.
   */
  await queue.work(QUEUES.funnelSweep, async () => {
    await fanOut(queue, QUEUES.funnelHourly, 'hourly');
    await fanOut(queue, QUEUES.recomputeIntent, 'intent');
  });
  await queue.work(QUEUES.dailySummariesSweep, () => fanOut(queue, QUEUES.dailySummaries, 'daily'));

  /*
   * Alerts (brief §9, M10).
   *
   * Decide then deliver, both inside one job: a held alert's `due_at` is what makes
   * the quiet-hours wait survive a restart, so the deliver half has to run on every
   * sweep and not only when something new was decided.
   */
  await queue.work<{ projectId: number }>(QUEUES.dispatchAlerts, async (jobs) => {
    for (const job of jobs) {
      const result = await runAlertDispatch(job.data.projectId, new Date());
      if (result.recorded > 0 || result.sent > 0 || result.failed > 0) {
        log.info('alerts', { projectId: job.data.projectId, ...result });
      }
    }
  });

  // Every live project, not only those with a funnel: see `activeProjects`.
  await queue.work(QUEUES.alertFanOut, () => fanOutAll(queue, QUEUES.dispatchAlerts, 'alerts'));

  /*
   * The two reports (brief §9, M10).
   *
   * The fan-out is HOURLY and the per-project job decides whether it is due where
   * the founder is. "Monday morning in the founder's timezone" cannot be a single
   * cron expression, and `report_runs`' unique index on the founder's own local date
   * is what stops a second copy.
   */
  await queue.work<{ projectId: number }>(QUEUES.weeklyReportFor, async (jobs) => {
    for (const job of jobs) {
      const result = await runWeeklyReport(job.data.projectId, new Date(), {
        send: sendSystemEmail,
        appUrl: process.env['APP_URL'] ?? null,
      });
      if (result.ran) {
        log.info('weekly report sent', {
          projectId: job.data.projectId,
          recipients: result.recipients,
          subject: result.subject,
        });
      } else {
        log.debug('weekly report skipped', { projectId: job.data.projectId, why: result.why });
      }
    }
  });

  await queue.work<{ projectId: number }>(QUEUES.dailyDigestFor, async (jobs) => {
    for (const job of jobs) {
      const result = await runDailyDigest(job.data.projectId, new Date(), {
        send: sendSystemEmail,
        appUrl: process.env['APP_URL'] ?? null,
      });
      if (result.ran) {
        log.info('digest sent', {
          projectId: job.data.projectId,
          recipients: result.recipients,
        });
      }
    }
  });

  await queue.work(QUEUES.reportFanOut, async () => {
    await fanOutAll(queue, QUEUES.weeklyReportFor, 'weekly');
    await fanOutAll(queue, QUEUES.dailyDigestFor, 'digest');
  });

  /*
   * Tracking health (brief §9, M11).
   *
   * Hourly, because the missing-event check compares a 24-hour window against a
   * 14-day baseline: checking more often would ask the same question of the same
   * data. The exit check is that stopping a key event raises a TRACKING alert within
   * one sweep — not an alert saying the users went away.
   */
  await queue.work<{ projectId: number }>(QUEUES.trackingHealth, async (jobs) => {
    for (const job of jobs) {
      const result = await runTrackingHealth(job.data.projectId, new Date());
      if (result.recorded > 0 || result.resolved > 0) {
        log.info('tracking health', {
          projectId: job.data.projectId,
          recorded: result.recorded,
          resolved: result.resolved,
          kinds: result.findings.map((finding) => finding.kind),
        });
      }
    }
  });

  await queue.work(QUEUES.trackingHealthFanOut, () =>
    fanOutAll(queue, QUEUES.trackingHealth, 'health'),
  );

  /*
   * Retention (brief §10, M11).
   *
   * Summaries first, then the deletes, in that order inside one job — the order is
   * the requirement, so it cannot be two jobs that might run out of sequence.
   */
  await queue.work<{ projectId: number }>(QUEUES.retention, async (jobs) => {
    for (const job of jobs) {
      const result = await runRetention(job.data.projectId, new Date());
      if (result.ran) {
        log.info('retention', {
          projectId: job.data.projectId,
          retentionDays: result.retentionDays,
          eventsDeleted: result.eventsDeleted,
          batches: result.batches,
          more: result.more,
        });
      }
    }
  });

  await queue.work(QUEUES.retentionFanOut, () => fanOutAll(queue, QUEUES.retention, 'retention'));

  await queue.work(QUEUES.unclaimedSweep, async () => {
    const result = await sweepUnclaimedProjects(new Date());
    if (result.stopped > 0 || result.deleted > 0) {
      log.info('unclaimed projects swept', { stopped: result.stopped, deleted: result.deleted });
    }
  });

  /*
   * The shadow copy (settled decision 1, M13).
   *
   * Dual writes go through the QUEUE, and that is the whole reason a dead shadow
   * cannot slow ingest: the request path writes to the primary, hands over a list of
   * message hashes and returns. This is the only thing that ever waits on the copy.
   */
  if (shadowConfigured()) {
    await queue.work<{ projectId: number; messageHashes: string[] }>(
      QUEUES.shadowCopy,
      async (jobs) => {
        for (const job of jobs) {
          const result = await withoutProject(
            'worker-sweep',
            (db) =>
              copyBatchToShadow((sql, params) => db.query<Record<string, unknown>>(sql, params), {
                projectId: job.data.projectId,
                messageHashes: job.data.messageHashes,
              }),
            { worker: true },
          );
          if (result.skippedBecause !== null) {
            log.warn('shadow copy skipped', {
              projectId: job.data.projectId,
              attempted: result.attempted,
              because: result.skippedBecause,
            });
          }
        }
      },
    );

    await queue.work(QUEUES.reconcileShadow, async () => {
      const result = await reconcile(new Date());
      const says = describeReconciliation(result);
      if (result.ran && result.clean) log.info('shadow reconciled', { says });
      else log.warn('shadow reconciliation', { says, gaps: result.gaps });
    });

    /*
     * Daily at 04:23, AFTER retention at 03:17.
     *
     * Reconciling before retention has run would compare a primary that has just
     * deleted old events against a shadow that has not, and report a gap that is
     * really a delete in flight.
     */
    await queue.schedule(QUEUES.reconcileShadow, '23 4 * * *');
    log.info('shadow copy is on');
  } else {
    /*
     * Said out loud, once, at startup.
     *
     * Settled decision 1 gates real founder data on the shadow copy OR Supabase Pro
     * backups. A worker running without either should not be quiet about it.
     */
    log.warn('no shadow copy configured', {
      note: 'Settled decision 1: no real founder data until the shadow copy or Supabase Pro backups exist.',
    });
  }

  // Every 5 minutes, and hourly for the collapse test (brief §8.3).
  await queue.schedule(QUEUES.leakSweepFanOut, '*/5 * * * *');
  await queue.schedule(QUEUES.collapseFanOut, '23 * * * *');
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
  /*
   * Alerts every 5 minutes, two minutes after the leak sweep, so a leak found at
   * :05 is alerted at :07 rather than waiting for the next pass.
   */
  await queue.schedule(QUEUES.alertFanOut, '2-59/5 * * * *');
  // Hourly at :19. Each project's own job decides whether it is Monday morning or
  // evening THERE; this only has to come round often enough not to miss an hour.
  await queue.schedule(QUEUES.reportFanOut, '19 * * * *');
  // Hourly at :41, away from the other passes so they do not contend.
  await queue.schedule(QUEUES.trackingHealthFanOut, '41 * * * *');
  /*
   * Retention at 03:17, AFTER the 02:11 nightly summaries.
   *
   * It writes its own summary first anyway — the order is enforced inside the job,
   * not by the schedule — but running it after the nightly pass means the day's
   * aggregates are already there and the delete is the only work left.
   */
  await queue.schedule(QUEUES.retentionFanOut, '17 3 * * *');
  await queue.schedule(QUEUES.unclaimedSweep, '43 3 * * *');

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

/**
 * Sends one job per LIVE project, funnel or not.
 *
 * The alert and report sweeps use this rather than `fanOut`: a founder who has wired
 * events but not yet confirmed their funnel still has intent scores, still has leaks
 * that do not depend on steps, and is the founder most worth emailing.
 */
async function fanOutAll(queue: Queue, target: string, label: string): Promise<void> {
  const projects = await activeProjects();
  if (projects.length === 0) return;
  for (const projectId of projects) {
    await queue.send(target, { projectId }, { singletonKey: `${label}:${projectId}` });
  }
  log.debug('sweep', { pass: label, projects: projects.length });
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

    // The shadow's own health, beside the queue's (M13: "shadow reads that log
    // differences and latency").
    if (shadowConfigured()) {
      const shadow = shadowStats();
      if (shadow.failed > 0 || shadow.timedOut > 0) {
        log.warn('shadow health', {
          attempted: shadow.attempted,
          succeeded: shadow.succeeded,
          failed: shadow.failed,
          timedOut: shadow.timedOut,
          lastError: shadow.lastError,
          lastLatencyMs: shadow.lastLatencyMs,
        });
      }
    }
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

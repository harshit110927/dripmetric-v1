import { PgBoss } from 'pg-boss';
import { dbEnv } from '@dripmetric/db';

/**
 * The queue adapter (settled decision D3).
 *
 * pg-boss sits behind this interface and nothing else in the codebase imports it, so
 * swapping it later is one file. Verified against pg-boss 12.38.0 on 2026-10-28: MIT,
 * needs Node >= 22.12, and since v10 a queue must be created before anything is sent
 * to it.
 *
 * It runs on the WORKER connection, not the request pool: pg-boss needs advisory
 * locks, LISTEN/NOTIFY and long transactions, which Supabase's transaction pooler
 * does not support (brief section 12).
 */

export interface QueueJob<T> {
  id: string;
  data: T;
}

/**
 * How a queue treats duplicates. Verified against pg-boss 12.38.0: the default
 * `standard` does NOT collapse jobs sharing a `singletonKey`, which is easy to
 * assume and wrong.
 *
 *  - `standard`  every job is its own job.
 *  - `short`     at most one job QUEUED per singletonKey, unlimited active. This is
 *                what ingest follow-ups want: two batches for the same person mean
 *                one recompute, without holding back one already running.
 *  - `singleton` at most one job ACTIVE per singletonKey, unlimited queued.
 */
export type QueuePolicy = 'standard' | 'short' | 'singleton';

export interface Queue {
  /** Declares a queue. Must be called before send() or work() touch it. */
  ensure(name: string, policy?: QueuePolicy): Promise<void>;
  send<T extends object>(name: string, data: T, options?: SendOptions): Promise<void>;
  work<T extends object>(
    name: string,
    handler: (jobs: QueueJob<T>[]) => Promise<void>,
    options?: WorkOptions,
  ): Promise<void>;
  /** A recurring job, in the given IANA time zone (brief section 12: real zones, DST and all). */
  schedule(name: string, cron: string, timezone?: string): Promise<void>;
  health(): Promise<QueueHealth>;
  stop(): Promise<void>;
}

export interface SendOptions {
  /**
   * Groups jobs for the queue's policy. On a `short` queue, two jobs sharing a key
   * collapse into one while they are waiting. On a `standard` queue it only labels
   * them, so the policy has to be set when the queue is declared.
   */
  singletonKey?: string;
  retryLimit?: number;
  startAfterSeconds?: number;
}

export interface WorkOptions {
  batchSize?: number;
  pollingIntervalSeconds?: number;
}

export interface QueueHealth {
  /** Queue depth, oldest job age and failure rate: the M13 metrics, wired early. */
  queues: { name: string; pending: number; oldestSeconds: number | null }[];
}

export async function startQueue(): Promise<Queue> {
  const env = dbEnv();
  const boss = new PgBoss({
    connectionString: env.WORKER_DATABASE_URL || env.DATABASE_URL,
    // pg-boss keeps its own schema, so a dump and restore of `public` stays clean
    // and leaving Supabase remains a dump and a restore (settled decision 1).
    schema: 'pgboss',
    // Migration 0003 creates that schema. Letting pg-boss create it would need
    // CREATE on the DATABASE, and that is the one privilege the application role
    // must not have: it would let the role build itself a table outside every
    // row-level security policy we wrote.
    createSchema: false,
  });

  boss.on('error', (error: Error) => {
    console.error(JSON.stringify({ level: 'error', msg: 'pg-boss error', err: String(error) }));
  });

  await boss.start();
  const declared = new Set<string>();

  return {
    async ensure(name, policy = 'standard') {
      if (declared.has(name)) return;
      await boss.createQueue(name, { policy });
      declared.add(name);
    },
    async send(name, data, options = {}) {
      await boss.send(name, data, {
        ...(options.singletonKey ? { singletonKey: options.singletonKey } : {}),
        retryLimit: options.retryLimit ?? 3,
        retryBackoff: true,
        ...(options.startAfterSeconds ? { startAfter: options.startAfterSeconds } : {}),
      });
    },
    async work<T extends object>(
      name: string,
      handler: (jobs: QueueJob<T>[]) => Promise<void>,
      options: WorkOptions = {},
    ) {
      await boss.work(
        name,
        {
          batchSize: options.batchSize ?? 1,
          pollingIntervalSeconds: options.pollingIntervalSeconds ?? 5,
        },
        async (jobs: { id: string; data: unknown }[]) => {
          await handler(jobs.map((job) => ({ id: job.id, data: job.data as T })));
        },
      );
    },
    async schedule(name, cron, timezone = 'UTC') {
      await boss.schedule(name, cron, null, { tz: timezone });
    },
    async health() {
      const queues: QueueHealth['queues'] = [];
      for (const name of declared) {
        const queue = await boss.getQueue(name);
        queues.push({
          name,
          pending: queue?.deferredCount ?? 0,
          oldestSeconds: null,
        });
      }
      return { queues };
    },
    async stop() {
      await boss.stop({ graceful: true });
    },
  };
}

/** Every queue the worker runs. Named here so nothing invents a queue name inline. */
export const QUEUES = {
  /** Every 5 minutes: the leak sweeps (M8). */
  sweepLeaks: 'sweep-leaks',
  /** Hourly: the funnel's hourly aggregates and thresholds (M6). */
  funnelHourly: 'funnel-hourly',
  /** Hourly, fanning out: which projects have a funnel to aggregate (M6). */
  funnelSweep: 'funnel-sweep',
  /** Nightly, fanning out: the same, for the daily pass (M6). */
  dailySummariesSweep: 'daily-summaries-sweep',
  /** Hourly: the step-completion collapse test (M8). */
  checkCollapse: 'check-collapse',
  /** Every 5 minutes, fanning out: which projects to sweep for leaks (M8). */
  leakSweepFanOut: 'leak-sweep-fan-out',
  /** Hourly, fanning out: the same, for the collapse test (M8). */
  collapseFanOut: 'collapse-fan-out',
  /** Nightly: summaries first, then the retention deletes (M11). */
  dailySummaries: 'daily-summaries',
  /** Monday morning in the founder's timezone: the weekly leak report (M10). */
  weeklyReport: 'weekly-report',
  /** After a mapping or funnel change: rebuild derived state (M5). */
  recompute: 'recompute',
  /** Every minute: find the projects with a recompute waiting and fan out (M5). */
  recomputeSweep: 'recompute-sweep',
  /** After ingest: refresh one user's intent score (M7). */
  recomputeIntent: 'recompute-intent',
  /** Every 5 minutes: decide and deliver this project's alerts (M10). */
  dispatchAlerts: 'dispatch-alerts',
  /** Every 5 minutes, fanning out: which projects to dispatch for (M10). */
  alertFanOut: 'alert-fan-out',
  /**
   * HOURLY, fanning out, for both reports (M10).
   *
   * Hourly rather than weekly because "Monday morning in the founder's timezone"
   * cannot be one cron: the job asks each project whether it is Monday 08:00 THERE
   * yet, and `report_runs` makes the answer idempotent.
   */
  reportFanOut: 'report-fan-out',
  /** The weekly leak report for one project, if it is due there (M10). */
  weeklyReportFor: 'weekly-report-for',
  /** The daily digest for one project, if it is due there (M10). */
  dailyDigestFor: 'daily-digest-for',
  /** Hourly: watch the tracking itself (M11). */
  trackingHealth: 'tracking-health',
  /** Hourly, fanning out: which projects to check (M11). */
  trackingHealthFanOut: 'tracking-health-fan-out',
  /** Nightly: summaries first, then delete raw events past the window (M11). */
  retention: 'retention',
  /** Nightly, fanning out: the same (M11). */
  retentionFanOut: 'retention-fan-out',
  /** Nightly: stop ingesting for unclaimed projects at 14 days, delete at 30 (M11). */
  unclaimedSweep: 'unclaimed-sweep',
} as const;

/**
 * The policy each queue is declared with. A queue not named here is `standard`.
 *
 * `recompute-intent` is `short` because ingest queues one follow-up per person per
 * batch: a busy person would otherwise pile up a recompute per batch, all of which
 * would read the same facts and reach the same score.
 */
export const QUEUE_POLICIES: Partial<Record<string, QueuePolicy>> = {
  [QUEUES.recomputeIntent]: 'short',
  [QUEUES.recompute]: 'short',
  // One sweep queued at a time: a second would find the same projects.
  [QUEUES.recomputeSweep]: 'short',
  [QUEUES.funnelSweep]: 'short',
  [QUEUES.dailySummariesSweep]: 'short',
  // One pending sweep per project: a second would find the same leaks.
  [QUEUES.sweepLeaks]: 'short',
  [QUEUES.checkCollapse]: 'short',
  [QUEUES.leakSweepFanOut]: 'short',
  [QUEUES.collapseFanOut]: 'short',
  // One pending aggregate per project: two would recompute the same rows.
  [QUEUES.funnelHourly]: 'short',
  [QUEUES.dailySummaries]: 'short',
  /*
   * The alert queues are `short` for a reason that matters more than efficiency.
   *
   * Two dispatch jobs for one project running at once would both read the same
   * "sent today" count and both think they had room, so the 10-a-day cap could be
   * exceeded. The unique index on `alerts` stops a duplicate alert; nothing but this
   * stops a duplicate COUNT.
   */
  [QUEUES.dispatchAlerts]: 'short',
  [QUEUES.alertFanOut]: 'short',
  [QUEUES.reportFanOut]: 'short',
  [QUEUES.weeklyReportFor]: 'short',
  [QUEUES.dailyDigestFor]: 'short',
  [QUEUES.trackingHealth]: 'short',
  [QUEUES.trackingHealthFanOut]: 'short',
  /*
   * Retention is `short` for a reason worth stating: two passes for one project at
   * once would both pick the oldest remaining day and issue overlapping DELETEs.
   * `retention_runs`' unique key already makes the second a no-op, but not before it
   * has written a summary and started deleting.
   */
  [QUEUES.retention]: 'short',
  [QUEUES.retentionFanOut]: 'short',
  [QUEUES.unclaimedSweep]: 'short',
};

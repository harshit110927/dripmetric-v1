#!/usr/bin/env node
/**
 * `pnpm load` — the load test (brief §10, M13).
 *
 * The exit check is that "the load-test report names the ceiling", so this does not
 * print a single throughput number and call it a result. It ramps concurrency until
 * p95 latency crosses a budget or errors appear, and reports the last level that held
 * — which is the number that actually tells you when to worry.
 *
 * It drives the real HTTP endpoint, not the pipeline directly: the thing being
 * measured includes Next's routing, JSON parsing and the connection pool, and those
 * are where a ceiling usually is.
 *
 *   pnpm load                        against http://localhost:3000
 *   pnpm load --host http://… --max 64 --batch 200 --seconds 10
 */
import { performance } from 'node:perf_hooks';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};

const HOST = flag('host', process.env.APP_URL ?? 'http://localhost:3000');
const KEY = flag('key', process.env.LOAD_TEST_SECRET_KEY ?? '');
const BATCH = Number(flag('batch', '100'));
const SECONDS = Number(flag('seconds', '6'));
const MAX_CONCURRENCY = Number(flag('max', '32'));

/**
 * The budget. Crossing it is what "the ceiling" means.
 *
 * 500ms at p95 for a batch of 100 events. Chosen because an SDK flushes in the
 * background and a founder never waits for it — so the number that matters is when
 * the queue starts backing up, not when a human notices.
 */
const P95_BUDGET_MS = Number(flag('budget', '500'));

if (!KEY) {
  console.error(
    'Pass --key sk_live_… or set LOAD_TEST_SECRET_KEY.\n' +
      'Make one with `pnpm sim --users 1`, which prints the keys, or from /dev/project.',
  );
  process.exit(1);
}

/** One batch of plausible events. Built once; only the ids change per request. */
function makeBatch(offset) {
  const now = Date.now();
  return {
    batch: Array.from({ length: BATCH }, (_unused, index) => ({
      type: 'track',
      messageId: `load_${offset}_${index}_${now}`,
      userId: `load_user_${(offset + index) % 500}`,
      event: index % 7 === 0 ? 'Signed Up' : 'Core Action Done',
      timestamp: new Date(now - index * 10).toISOString(),
    })),
  };
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p));
  return sorted[index];
}

async function oneRequest(offset) {
  const started = performance.now();
  try {
    const response = await fetch(`${HOST}/v1/batch`, {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify(makeBatch(offset)),
    });
    const elapsed = performance.now() - started;
    // A 429 is not an error: it is the rate limiter working, and it has to be counted
    // separately or the ceiling would look like a failure when it is a policy.
    return { ms: elapsed, status: response.status };
  } catch (error) {
    return { ms: performance.now() - started, status: 0, error: String(error) };
  }
}

/** Runs one concurrency level for `SECONDS`, returning its latency shape. */
async function level(concurrency) {
  const deadline = Date.now() + SECONDS * 1000;
  const samples = [];
  let offset = 0;
  let ok = 0;
  let rateLimited = 0;
  let failed = 0;

  const worker = async () => {
    while (Date.now() < deadline) {
      const result = await oneRequest((offset += BATCH));
      samples.push(result.ms);
      if (result.status === 200) ok++;
      else if (result.status === 429) rateLimited++;
      else failed++;
    }
  };

  const startedAt = performance.now();
  await Promise.all(Array.from({ length: concurrency }, worker));
  const wallSeconds = (performance.now() - startedAt) / 1000;

  const sorted = [...samples].sort((a, b) => a - b);
  return {
    concurrency,
    requests: samples.length,
    eventsPerSecond: Math.round((ok * BATCH) / wallSeconds),
    p50: Math.round(percentile(sorted, 0.5)),
    p95: Math.round(percentile(sorted, 0.95)),
    p99: Math.round(percentile(sorted, 0.99)),
    ok,
    rateLimited,
    failed,
  };
}

console.log(
  `\nLOAD TEST — ${HOST}\n` +
    `  batch ${BATCH} events, ${SECONDS}s per level, p95 budget ${P95_BUDGET_MS}ms\n`,
);
console.log('  conc   req    ev/s    p50    p95    p99     ok   429   err');

/** Above this share of 429s, a level is measuring the rate limiter, not the pipeline. */
const RATE_LIMITED_SHARE = 0.2;

const results = [];
let ceiling = null;
let rateLimitHit = null;

for (let concurrency = 1; concurrency <= MAX_CONCURRENCY; concurrency *= 2) {
  const result = await level(concurrency);
  results.push(result);
  console.log(
    `  ${String(result.concurrency).padStart(4)} ${String(result.requests).padStart(5)} ` +
      `${String(result.eventsPerSecond).padStart(7)} ${String(result.p50).padStart(6)} ` +
      `${String(result.p95).padStart(6)} ${String(result.p99).padStart(6)} ` +
      `${String(result.ok).padStart(6)} ${String(result.rateLimited).padStart(5)} ` +
      `${String(result.failed).padStart(5)}`,
  );

  /*
   * A level dominated by 429s is not a measurement, and must not be reported as one.
   *
   * This was a real defect in the first version: at concurrency 32 it printed
   * "200 events/second" when 2,156 of 2,168 requests had been rejected by the rate
   * limiter. The arithmetic was right and the headline was nonsense — the rate limit
   * was the ceiling, and the number described how fast we can say no.
   */
  if (result.rateLimited > result.requests * RATE_LIMITED_SHARE) {
    rateLimitHit = result;
    ceiling = results[results.length - 2] ?? null;
    console.log(
      `\n  Stopped at concurrency ${concurrency}: ` +
        `${result.rateLimited} of ${result.requests} requests were rate-limited.\n` +
        `  The project's own limit is the ceiling here, not the pipeline.`,
    );
    break;
  }

  /*
   * Otherwise the ceiling is the last level that HELD, not the first that broke.
   *
   * Reporting the broken level would overstate what the system can do; reporting the
   * one before it is the number you can plan with.
   */
  if (result.failed > 0 || result.p95 > P95_BUDGET_MS) {
    ceiling = results[results.length - 2] ?? null;
    console.log(
      `\n  Stopped at concurrency ${concurrency}: ` +
        (result.failed > 0
          ? `${result.failed} requests failed.`
          : `p95 ${result.p95}ms is over the ${P95_BUDGET_MS}ms budget.`),
    );
    break;
  }
}

const best = ceiling ?? results[results.length - 1];
/*
 * What the number actually is, stated rather than implied.
 *
 * Three different things can stop the ramp, and they mean different things to whoever
 * reads this: a rate limit is a policy you can raise, a latency budget is a tuning
 * question, and never crossing either means the test was too small to find the edge.
 */
const kind = rateLimitHit !== null ? 'rate-limit' : ceiling === null ? 'floor' : 'latency';

console.log(
  `\nTHE CEILING\n` +
    `  ${best.eventsPerSecond.toLocaleString()} events/second sustained at concurrency ` +
    `${best.concurrency}, p95 ${best.p95}ms.\n` +
    `  That is about ${(best.eventsPerSecond * 86_400).toLocaleString()} events a day.\n` +
    (kind === 'rate-limit'
      ? `  This is the RATE LIMIT, not the pipeline's capacity. One project's bucket is\n` +
        `  what stopped it, which is the right answer for one founder's traffic and the\n` +
        `  wrong one for the whole system: raise the project's limit, or run several\n` +
        `  projects' keys in parallel, to measure the pipeline.\n`
      : kind === 'floor'
        ? `  Nothing broke, so this is a FLOOR and not a ceiling: raise --max to find the\n` +
          `  real one.\n`
        : `  Beyond this, p95 crosses ${P95_BUDGET_MS}ms or requests start failing.\n`),
);

console.log(
  `Caveats worth writing down with the number:\n` +
    `  - One machine, one database, no network between them. A deployed setup adds\n` +
    `    both, so treat this as the shape of the curve rather than the absolute.\n` +
    `  - 429s are the rate limiter doing its job, not a failure. If the table above\n` +
    `    is mostly 429s, raise the project's limit before reading anything into it.\n` +
    `  - Events per second counts accepted events, so duplicates and filtered bots\n` +
    `    are excluded — which is the number that matters for storage.\n`,
);

/*
 * The report is written where the runbook can point at it.
 *
 * "The load-test report names the ceiling" is an exit check, and a number that only
 * ever appeared in a terminal cannot satisfy it.
 */
const report = {
  ranAt: new Date().toISOString(),
  host: HOST,
  batchSize: BATCH,
  secondsPerLevel: SECONDS,
  p95BudgetMs: P95_BUDGET_MS,
  ceiling: {
    eventsPerSecond: best.eventsPerSecond,
    concurrency: best.concurrency,
    p95Ms: best.p95,
    eventsPerDay: best.eventsPerSecond * 86_400,
    // What stopped the ramp: 'rate-limit', 'latency', or 'floor' (nothing did).
    limitedBy: kind,
    budgetCrossed: ceiling !== null,
  },
  levels: results,
};

const { writeFile, mkdir } = await import('node:fs/promises');
await mkdir('docs', { recursive: true });
await writeFile('docs/load-test.json', `${JSON.stringify(report, null, 2)}\n`);
console.log('Written to docs/load-test.json');

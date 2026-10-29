import {
  checkoutSummary,
  coverageFacts,
  currentProject,
  dailySummaryRows,
  entitlements,
  eventSourceShare,
  intentPeople,
  leakPeople,
  limitOf,
  listChanges,
  retentionCohortRows,
  retentionHeadline,
  revealAllowanceNote,
  revealState,
  serializeContext,
  setupState,
  stepTrendRows,
  type ScopedDb,
} from '@dripmetric/db';
import { coverage } from '@dripmetric/engine';
import { currentFunnelReport, intentSummary, leakSummary } from '@dripmetric/ingest';

/**
 * The eight dashboard modules, loaded once (brief §9).
 *
 * "Cache dashboard reads for 60 seconds. Every number can show how it is computed."
 *
 * One function so a page renders from one await rather than eight, and so the cache
 * has one key. Nothing here decides what to show: the reads are already gated by
 * `can()` in the data-access layer, which is the only place that decision exists.
 */

/** Brief §9: "Cache dashboard reads for 60 seconds." */
export const DASHBOARD_CACHE_MS = 60_000;

export type Dashboard = Awaited<ReturnType<typeof loadDashboardUncached>>;

async function loadDashboardUncached(db: ScopedDb, now: Date) {
  const project = await currentProject(db);
  const plan = await entitlements(db);
  const context = await serializeContext(db, now);
  const reveals = await revealState(db);

  /*
   * One after another, not in parallel.
   *
   * A `ScopedDb` is a single client inside a single transaction. `Promise.all` over
   * twelve reads looked like the obvious win and was wrong: pg deprecates a query
   * issued while another is running on the same client, queues them anyway today and
   * throws in pg 9 — so the "parallel" version was sequential with a warning. Real
   * parallelism would need a connection each, and a transaction cannot span two.
   */
  const leaks = await leakSummary(db, now);
  const funnel = await currentFunnelReport(db, now);
  const intent = await intentSummary(db, now);
  const checkout = await checkoutSummary(db);
  const retention = await retentionHeadline(db);
  const cohorts = await retentionCohortRows(db, 12);
  const trend = await stepTrendRows(db, now);
  const changes = await listChanges(db);
  const sources = await eventSourceShare(db, now);
  const facts = await coverageFacts(db);
  const setup = await setupState(db);
  const summaries = await dailySummaryRows(db, 14);

  // The three lists of people. Each one is serialized by the data-access layer, so a
  // free project gets tags and a paid project gets names, and this file cannot tell
  // the difference.
  const highIntent = await intentPeople(db, context, { minScore: 60, limit: 25 });
  const drops = await leakPeople(db, context, 'last-moment-drop', { limit: 25 });
  const quietPayers = await leakPeople(db, context, 'payer-going-quiet', { limit: 25 });

  return {
    computedAt: now,
    project,
    plan,
    retentionDays: limitOf(plan, 'retention_days'),
    reveals: { ...reveals, note: revealAllowanceNote(reveals, plan) },
    setup,
    leaks,
    funnel,
    intent,
    checkout,
    retention,
    cohorts,
    trend,
    changes,
    sources,
    coverage: coverage(facts),
    highIntent,
    drops,
    quietPayers,
    summaries,
  };
}

interface CacheEntry {
  at: number;
  value: Promise<Dashboard>;
}

/**
 * A 60-second cache, in process.
 *
 * Deliberately small and local rather than Next's own caching: these reads depend on
 * `now` and on the project's plan, and a cache that keyed on the URL would serve a
 * paid project's names to a free one after a downgrade. Keyed on the project id, with
 * the promise cached rather than the result, so two simultaneous requests do the work
 * once.
 */
const cache = new Map<number, CacheEntry>();

export async function loadDashboard(
  db: ScopedDb,
  now: Date,
  options: { fresh?: boolean } = {},
): Promise<Dashboard> {
  const key = db.projectId;
  const hit = cache.get(key);

  if (!options.fresh && hit && now.getTime() - hit.at < DASHBOARD_CACHE_MS) {
    return hit.value;
  }

  const value = loadDashboardUncached(db, now);
  cache.set(key, { at: now.getTime(), value });
  // A failed load must not be cached: the next refresh should try again.
  value.catch(() => cache.delete(key));
  return value;
}

/** Called after anything that changes what the dashboard would say. */
export function invalidateDashboard(projectId: number): void {
  cache.delete(projectId);
}

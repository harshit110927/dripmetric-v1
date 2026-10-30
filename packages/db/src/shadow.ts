import { shadowConfigured, shadowDbPool, SHADOW_TIMEOUT_MS } from './pool.js';
import { withoutProject } from './scope.js';

/**
 * The shadow copy (settled decision 1, M13).
 *
 * "A parallel self-managed shadow copy: dual writes through the worker, shadow reads
 * that log differences and latency, daily reconciliation, monthly drills."
 *
 * It exists for one reason: Supabase Free has no backups, and the gate on real
 * founder data is "the shadow copy or Supabase Pro backups". So the shadow is a
 * second place the data lives, maintained well enough to restore from.
 *
 * Every function here is built around one rule, which is also M13's exit check:
 * KILLING THE SHADOW MUST NOT SLOW INGEST. So nothing waits on it unbounded, nothing
 * throws because of it, and a dead shadow degrades to a counter and a log line.
 */

export interface ShadowStats {
  /** Writes attempted since the process started. */
  attempted: number;
  succeeded: number;
  failed: number;
  timedOut: number;
  /** Rows the shadow is behind by, as last measured. */
  lastLagRows: number | null;
  lastErrorAt: Date | null;
  lastError: string | null;
  /** Milliseconds, so M13's "shadow reads that log latency" has a number. */
  lastLatencyMs: number | null;
}

const stats: ShadowStats = {
  attempted: 0,
  succeeded: 0,
  failed: 0,
  timedOut: 0,
  lastLagRows: null,
  lastErrorAt: null,
  lastError: null,
  lastLatencyMs: null,
};

export function shadowStats(): Readonly<ShadowStats> {
  return { ...stats };
}

export function resetShadowStats(): void {
  stats.attempted = 0;
  stats.succeeded = 0;
  stats.failed = 0;
  stats.timedOut = 0;
  stats.lastLagRows = null;
  stats.lastErrorAt = null;
  stats.lastError = null;
  stats.lastLatencyMs = null;
}

/**
 * Runs something against the shadow, and never lets it matter.
 *
 * The timeout is a race rather than a statement_timeout, because the failure being
 * guarded against includes "the host is gone and the TCP connect hangs" — which a
 * server-side timeout cannot help with, since there is no server to set it on.
 *
 * It returns null on every failure, and the caller is expected to ignore that.
 */
export async function withShadow<T>(
  label: string,
  fn: (query: ShadowQuery) => Promise<T>,
): Promise<T | null> {
  const shadow = shadowDbPool();
  if (shadow === null) return null;

  stats.attempted++;
  const started = Date.now();

  try {
    const result = await Promise.race([
      (async (): Promise<T> => {
        const client = await shadow.connect();
        try {
          return await fn((sql, params) => client.query(sql, params as unknown[]));
        } finally {
          client.release();
        }
      })(),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new ShadowTimeout(label)), SHADOW_TIMEOUT_MS).unref(),
      ),
    ]);

    stats.succeeded++;
    stats.lastLatencyMs = Date.now() - started;
    return result;
  } catch (error) {
    if (error instanceof ShadowTimeout) stats.timedOut++;
    else stats.failed++;

    stats.lastErrorAt = new Date();
    stats.lastError = `${label}: ${error instanceof Error ? error.message : String(error)}`;
    stats.lastLatencyMs = Date.now() - started;

    /*
     * Logged, not thrown.
     *
     * A founder's events must land in the primary whatever the shadow is doing. The
     * worker's health report and the reconciliation job are where a dead shadow
     * becomes visible; the request path never learns about it.
     */
    console.error(
      JSON.stringify({
        level: 'warn',
        msg: 'shadow write skipped',
        label,
        err: stats.lastError,
      }),
    );
    return null;
  }
}

export type ShadowQuery = (sql: string, params?: readonly unknown[]) => Promise<unknown>;

class ShadowTimeout extends Error {
  constructor(label: string) {
    super(`the shadow did not answer within ${SHADOW_TIMEOUT_MS}ms`);
    this.name = 'ShadowTimeout';
    void label;
  }
}

// --- Reconciliation --------------------------------------------------------

export interface TableGap {
  table: string;
  primary: number;
  shadow: number;
  /** Positive when the shadow is behind. */
  missing: number;
}

export interface Reconciliation {
  ran: boolean;
  /** Why not, when the shadow is not configured or did not answer. */
  why: string;
  checkedAt: Date;
  gaps: TableGap[];
  /** True when every table matched. M13's exit check. */
  clean: boolean;
  latencyMs: number | null;
}

/**
 * The tables the reconciliation compares.
 *
 * Deliberately the ones that cannot be rebuilt: raw events and the identities they
 * point at. Everything else — step state, scores, leaks, summaries — is derived and
 * reproducible by the recompute job (CLAUDE.md rule 10), so a difference there is a
 * stale shadow rather than lost data, and counting it would produce noise that hides
 * the thing worth seeing.
 */
export const RECONCILED_TABLES = ['events', 'end_users', 'accounts', 'sessions'] as const;

/**
 * Compares row counts between the primary and the shadow (M13).
 *
 * Counts rather than checksums, on purpose. A checksum of every event would take
 * minutes on a real table and the question being asked is "is anything MISSING" —
 * which a count answers, cheaply, every night. A per-row comparison belongs in a
 * restore drill, where it runs once against a copy nobody is writing to.
 */
export async function reconcile(now: Date): Promise<Reconciliation> {
  const empty: Reconciliation = {
    ran: false,
    why: 'No shadow is configured.',
    checkedAt: now,
    gaps: [],
    clean: true,
    latencyMs: null,
  };
  if (!shadowConfigured()) return empty;

  const started = Date.now();
  const gaps: TableGap[] = [];

  for (const table of RECONCILED_TABLES) {
    const primaryCount = await countPrimary(table);
    const shadowCount = await withShadow(`count:${table}`, async (query) => {
      const result = (await query(`SELECT count(*)::bigint AS n FROM ${table}`)) as {
        rows: { n: string }[];
      };
      return Number(result.rows[0]?.n ?? 0);
    });

    if (shadowCount === null) {
      return {
        ran: false,
        why: 'The shadow did not answer.',
        checkedAt: now,
        gaps,
        clean: false,
        latencyMs: Date.now() - started,
      };
    }

    gaps.push({
      table,
      primary: primaryCount,
      shadow: shadowCount,
      missing: primaryCount - shadowCount,
    });
  }

  const latencyMs = Date.now() - started;
  stats.lastLagRows = gaps.reduce((n, gap) => n + Math.max(0, gap.missing), 0);

  return {
    ran: true,
    why: 'Compared.',
    checkedAt: now,
    gaps,
    clean: gaps.every((gap) => gap.missing === 0),
    latencyMs,
  };
}

/**
 * Counts a table across every project.
 *
 * Through `withoutProject` with the worker flag, which is what sets
 * `app_rls_bypassed()` — and getting this wrong was a real bug worth recording. The
 * first version used the request pool, which connects as the non-owner role under
 * FORCE ROW LEVEL SECURITY with no project set. It counted zero every time, so the
 * reconciliation compared 0 against 0 and reported CLEAN against any shadow at all,
 * including a totally empty one. A check that cannot fail is worse than no check: it
 * invites a restore that loses everything while looking like it worked.
 *
 * It was invisible until the test ran it against a database with rows in it, because
 * an empty primary and an empty shadow genuinely do match.
 */
async function countPrimary(table: string): Promise<number> {
  return withoutProject(
    'worker-sweep',
    async (db) => {
      const row = await db.one<{ n: string }>(`SELECT count(*)::bigint AS n FROM ${table}`);
      return Number(row.n);
    },
    { worker: true },
  );
}

/** Plain words for a drill log or a runbook entry. */
export function describeReconciliation(result: Reconciliation): string {
  if (!result.ran) return `Reconciliation did not run: ${result.why}`;
  if (result.clean) {
    return `Shadow matches the primary on ${RECONCILED_TABLES.length} tables (${result.latencyMs}ms).`;
  }
  const behind = result.gaps
    .filter((gap) => gap.missing !== 0)
    .map(
      (gap) => `${gap.table} ${gap.missing > 0 ? 'behind' : 'ahead'} by ${Math.abs(gap.missing)}`,
    )
    .join(', ');
  return `Shadow differs: ${behind}.`;
}

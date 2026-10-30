import pg from 'pg';
import { dbEnv } from './env.js';

/**
 * One pool per process.
 *
 * `pg` only prepares a statement when a query is given a `name`, and nothing in this
 * codebase names one. That is deliberate: Supabase's transaction pooler (port 6543)
 * does not support prepared statements, so the same code runs on a Vercel function
 * through the pooler and on the worker through a direct connection
 * (brief section 12, "Supabase connections").
 */
const { Pool } = pg;
export type PoolClient = pg.PoolClient;
export type QueryResultRow = pg.QueryResultRow;

let appPool: pg.Pool | undefined;
let workerPool: pg.Pool | undefined;
let shadowPool: pg.Pool | undefined;
/*
 * The URL the shadow pool was built for.
 *
 * Memoizing the pool without remembering its URL meant a changed
 * `SHADOW_DATABASE_URL` was silently ignored — harmless in production, where it never
 * changes, and wrong everywhere else: a test that repointed the shadow at a dead host
 * kept talking to the live one and "the shadow is unreachable" could not be tested at
 * all. Keyed on the URL, the pool is rebuilt when it moves.
 */
let shadowPoolUrl: string | undefined;

function make(connectionString: string, max: number): pg.Pool {
  const pool = new Pool({
    connectionString,
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // Postgres returns timestamptz as a Date in UTC; keep that, never a local string.
    application_name: 'dripmetric',
  });
  pool.on('error', (error) => {
    // An idle client erroring must not take the process down.
    console.error(
      JSON.stringify({ level: 'error', msg: 'idle pg client error', err: String(error) }),
    );
  });
  return pool;
}

/** The request-path pool. Small, because serverless functions multiply it. */
export function pool(): pg.Pool {
  appPool ??= make(dbEnv().DATABASE_URL, 10);
  return appPool;
}

/** The worker pool: a direct or session connection, so pg-boss works. */
export function workerDbPool(): pg.Pool {
  const env = dbEnv();
  workerPool ??= make(env.WORKER_DATABASE_URL || env.DATABASE_URL, 20);
  return workerPool;
}

/**
 * The shadow pool, or null when no shadow is configured (settled decision 1, M13).
 *
 * Deliberately small and impatient. A 2-second connect timeout rather than 10: the
 * shadow is a copy, and the exit check is that killing it does not slow ingest — so
 * every setting here is chosen to fail fast rather than to succeed eventually.
 */
export function shadowDbPool(): pg.Pool | null {
  const url = dbEnv().SHADOW_DATABASE_URL;
  if (!url) return null;

  if (shadowPool !== undefined && shadowPoolUrl !== url) {
    // Closed in the background: nothing waits on a pool being replaced.
    void shadowPool.end().catch(() => {});
    shadowPool = undefined;
  }
  shadowPoolUrl = url;

  shadowPool ??= (() => {
    const made = new Pool({
      connectionString: url,
      max: 4,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: SHADOW_TIMEOUT_MS,
      application_name: 'dripmetric-shadow',
    });
    made.on('error', (error) => {
      // A dead shadow is a logged fact, never an exception that reaches a founder.
      console.error(
        JSON.stringify({ level: 'warn', msg: 'shadow pg client error', err: String(error) }),
      );
    });
    return made;
  })();
  return shadowPool;
}

/**
 * How long anything will wait for the shadow before giving up.
 *
 * Two seconds. The brief's exit check is "killing the shadow does not slow ingest",
 * and the only way to keep that true is to bound every shadow operation and treat
 * the timeout as a normal outcome.
 */
export const SHADOW_TIMEOUT_MS = 2_000;

export function shadowConfigured(): boolean {
  return Boolean(dbEnv().SHADOW_DATABASE_URL);
}

export async function closePools(): Promise<void> {
  await Promise.all([appPool?.end(), workerPool?.end(), shadowPool?.end()]);
  appPool = undefined;
  workerPool = undefined;
  shadowPool = undefined;
  shadowPoolUrl = undefined;
}

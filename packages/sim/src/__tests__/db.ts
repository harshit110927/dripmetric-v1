import pg from 'pg';
import { runMigrations } from '@dripmetric/db/admin';

/**
 * Migrating and emptying the test database, for the sim tests.
 *
 * It was five copies of this table list — four here and one in
 * `packages/ingest/src/__tests__/helpers.ts` — and they had already drifted: only
 * `sim/ingest.test.ts` was missing `changes`, which failed the moment another test
 * file left a change behind, with an error naming `changes.project_id` and pointing
 * nowhere near the cause. A list that must track the schema belongs in one place.
 */

let migrated = false;

export async function ensureMigrated(): Promise<void> {
  if (migrated) return;
  const client = await adminClient();
  try {
    await runMigrations(client);
    await client.query(`ALTER ROLE dripmetric_app LOGIN PASSWORD 'dripmetric_app'`);
  } finally {
    await client.end();
  }
  migrated = true;
}

export async function adminClient(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: process.env['ADMIN_DATABASE_URL'] });
  await client.connect();
  return client;
}

/**
 * Deleted in dependency order, parents last.
 *
 * Two orderings here are load-bearing rather than tidy:
 *
 *  - `changes` BEFORE `funnel_steps`. Its foreign key is composite —
 *    (project_id, step_id) REFERENCES funnel_steps ON DELETE SET NULL — so deleting a
 *    step tries to NULL both columns and `project_id` is NOT NULL.
 *  - the alert tables before `leak_instances`, for the same reason in miniature.
 *
 * Everything else would cascade from `projects`, but deleting explicitly keeps the
 * error message useful when a new table lands with a constraint nobody expected.
 */
const TABLES = [
  'signup_attempts',
  'sources',
  'alert_deliveries',
  'alerts',
  'integration_installs',
  'integrations',
  'report_subscriptions',
  'report_runs',
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
  'reveals',
  'audit_log',
  'api_keys',
  'project_members',
  'magic_link_tokens',
  'founder_sessions',
  'founder_users',
] as const;

export async function resetData(): Promise<void> {
  const client = await adminClient();
  try {
    await client.query("SET lock_timeout = '10s'");
    for (const table of TABLES) await client.query(`DELETE FROM ${table}`);
    await client.query('UPDATE end_users SET account_id = NULL');
    await client.query('DELETE FROM accounts');
    await client.query('DELETE FROM end_users');
    await client.query("DELETE FROM projects WHERE mode = 'test'");
    await client.query('DELETE FROM projects');
  } finally {
    await client.end();
  }
}

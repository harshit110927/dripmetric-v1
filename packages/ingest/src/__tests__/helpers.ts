import pg from 'pg';
import { createProject, type CreatedProject } from '@dripmetric/db';
import { runMigrations } from '@dripmetric/db/admin';
import type { IngestRequest, IngestResponse } from '../types.js';
import { handleBatch } from '../handler.js';

let migrated = false;

export async function ensureMigrated(): Promise<void> {
  if (migrated) return;
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

export async function adminClient(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: process.env['ADMIN_DATABASE_URL'] });
  await client.connect();
  return client;
}

export async function resetData(): Promise<void> {
  const client = await adminClient();
  try {
    await client.query("SET lock_timeout = '10s'");
    for (const table of [
      /*
       * `changes` goes first, before `funnel_steps`.
       *
       * Its foreign key is composite — (project_id, step_id) REFERENCES funnel_steps
       * ON DELETE SET NULL — so deleting a step tries to NULL both columns, and
       * `project_id` is NOT NULL. Deleting the changes first is the only order that
       * works, and the error it otherwise throws names `changes.project_id`, which
       * points nowhere near `funnel_steps`.
       */
      'changes',
      'alert_deliveries',
      'alerts',
      'integration_installs',
      'integrations',
      'report_subscriptions',
      'report_runs',
      'leak_instances',
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
      'event_names',
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

export interface Fixture {
  project: CreatedProject;
  secretKey: string;
  publishableKey: string;
}

export async function newFixture(name = 'Acme'): Promise<Fixture> {
  const project = await createProject({ name });
  const secret = project.keys.find((k) => k.kind === 'secret' && k.mode === 'live');
  const publishable = project.keys.find((k) => k.kind === 'publishable' && k.mode === 'live');
  if (!secret || !publishable) throw new Error('createProject did not return both live keys.');
  return { project, secretKey: secret.token, publishableKey: publishable.token };
}

export interface PostOptions {
  key?: string;
  /** Sends the key as the Basic-auth username, the way Segment's libraries do. */
  basic?: boolean;
  /** Leaves the Authorization header off entirely, as `sendBeacon` must. */
  noAuthHeader?: boolean;
  contentType?: string;
  origin?: string;
  userAgent?: string;
  country?: string;
  receivedAt?: Date;
  source?: IngestRequest['source'];
}

/** Posts a raw body to the pipeline, exactly as a route handler would. */
export async function postRaw(body: string, options: PostOptions = {}): Promise<IngestResponse> {
  const headers: Record<string, string | undefined> = {
    'content-type': options.contentType ?? 'application/json',
  };
  if (!options.noAuthHeader && options.key) {
    headers['authorization'] = options.basic
      ? `Basic ${Buffer.from(`${options.key}:`).toString('base64')}`
      : `Bearer ${options.key}`;
  }
  if (options.origin) headers['origin'] = options.origin;
  if (options.userAgent) headers['user-agent'] = options.userAgent;
  if (options.country) headers['x-vercel-ip-country'] = options.country;

  return handleBatch({
    body,
    headers,
    receivedAt: options.receivedAt ?? new Date(),
    ...(options.source ? { source: options.source } : {}),
  });
}

export async function postBatch(
  batch: unknown[],
  options: PostOptions & { sentAt?: string; writeKey?: string } = {},
): Promise<IngestResponse> {
  const body: Record<string, unknown> = { batch };
  if (options.sentAt) body['sentAt'] = options.sentAt;
  if (options.writeKey) body['writeKey'] = options.writeKey;
  return postRaw(JSON.stringify(body), options);
}

export interface BatchReply {
  results: { messageId: string; status: string; code: string; message?: string }[];
  accepted: number;
}

export function reply(response: IngestResponse): BatchReply {
  return response.body as BatchReply;
}

/** A Segment-shaped track message with sensible defaults. */
export function track(
  event: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: 'track',
    messageId: `m-${Math.random().toString(36).slice(2)}`,
    userId: 'user_123',
    event,
    ...overrides,
  };
}

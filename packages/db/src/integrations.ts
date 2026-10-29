import { createHash, randomBytes } from 'node:crypto';
import { decryptText, encrypt } from './crypto.js';
import type { ScopedDb } from './scope.js';

/**
 * Slack and Discord, installed by OAuth (brief §9's Alerts).
 *
 * "Slack's `incoming-webhook` scope shows a channel picker and returns a webhook URL;
 * Discord's OAuth2 webhook flow returns a channel webhook the same way. Store those
 * URLs encrypted."
 *
 * A webhook URL is a bearer credential: whoever holds it can post into the founder's
 * channel as us. So it goes through the same envelope encryption as an end-user
 * email, and it leaves this file in exactly one direction — `liveIntegration`, which
 * the dispatcher calls and nothing else does. The settings screen gets
 * `integrationSummary`, which cannot return it.
 */

export type IntegrationKind = 'slack' | 'discord';

/** What a screen is allowed to know: which channel, when, and whether it is working. */
export interface IntegrationSummary {
  id: string;
  kind: IntegrationKind;
  channelLabel: string;
  workspaceLabel: string;
  installedAt: Date;
  lastDeliveryAt: Date | null;
  lastError: string | null;
}

/** The same, plus the credential. Only the dispatcher asks for this. */
export interface LiveIntegration extends IntegrationSummary {
  webhookUrl: string;
}

export interface InstallInput {
  kind: IntegrationKind;
  webhookUrl: string;
  channelLabel: string;
  workspaceLabel: string;
}

const SUMMARY_COLUMNS = `
  id, kind, channel_label, workspace_label, installed_at, last_delivery_at, last_error
`;

interface SummaryRow {
  id: string;
  kind: IntegrationKind;
  channel_label: string;
  workspace_label: string;
  installed_at: Date;
  last_delivery_at: Date | null;
  last_error: string | null;
}

function toSummary(row: SummaryRow): IntegrationSummary {
  return {
    id: row.id,
    kind: row.kind,
    channelLabel: row.channel_label,
    workspaceLabel: row.workspace_label,
    installedAt: row.installed_at,
    lastDeliveryAt: row.last_delivery_at,
    lastError: row.last_error,
  };
}

/** Every live integration, for the settings screen. Never the URLs. */
export async function integrationSummary(db: ScopedDb): Promise<IntegrationSummary[]> {
  const rows = await db.query<SummaryRow>(
    `SELECT ${SUMMARY_COLUMNS} FROM integrations
      WHERE project_id = $1 AND revoked_at IS NULL
      ORDER BY installed_at DESC`,
    [db.projectId],
  );
  return rows.map(toSummary);
}

/**
 * The live integration of a kind, with its webhook URL decrypted.
 *
 * The one read that returns a credential. Called by the alert dispatcher, which is
 * about to post to it; if a screen ever needs this, the screen is wrong.
 */
export async function liveIntegration(
  db: ScopedDb,
  kind: IntegrationKind,
): Promise<LiveIntegration | null> {
  const row = await db.maybeOne<
    SummaryRow & { webhook_ciphertext: Buffer; webhook_key_id: string }
  >(
    `SELECT ${SUMMARY_COLUMNS}, webhook_ciphertext, webhook_key_id FROM integrations
      WHERE project_id = $1 AND kind = $2 AND revoked_at IS NULL`,
    [db.projectId, kind],
  );
  if (!row) return null;
  return {
    ...toSummary(row),
    webhookUrl: decryptText(row.webhook_ciphertext, row.webhook_key_id),
  };
}

/**
 * Stores a fresh install, replacing any previous one of the same kind.
 *
 * Replacing rather than adding: the unique index enforces one live integration per
 * kind, and a founder who reinstalls to pick a different channel means "post there
 * instead", not "post to both".
 */
export async function saveIntegration(
  db: ScopedDb,
  input: InstallInput,
  actorUserId: string | null,
): Promise<IntegrationSummary> {
  const secret = encrypt(input.webhookUrl);

  await db.exec(
    `UPDATE integrations
        SET revoked_at = now(), revoked_reason = 'replaced by a newer install'
      WHERE project_id = $1 AND kind = $2 AND revoked_at IS NULL`,
    [db.projectId, input.kind],
  );

  const row = await db.one<SummaryRow>(
    `INSERT INTO integrations
       (project_id, kind, webhook_ciphertext, webhook_key_id,
        channel_label, workspace_label, installed_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${SUMMARY_COLUMNS}`,
    [
      db.projectId,
      input.kind,
      secret.bytes,
      secret.keyId,
      input.channelLabel.slice(0, 200),
      input.workspaceLabel.slice(0, 200),
      actorUserId,
    ],
  );

  /*
   * The audit log records the CHANNEL, never the URL.
   *
   * The audit log is the one table built to be read by a human looking for what went
   * wrong, which makes it the last place to put a credential — it would be the one
   * copy nobody thought to encrypt.
   */
  await db.exec(
    `INSERT INTO audit_log (project_id, actor_user_id, action, subject, details)
     VALUES ($1, $2, 'integration.installed', $3, $4)`,
    [
      db.projectId,
      actorUserId,
      input.kind,
      JSON.stringify({ channel: input.channelLabel, workspace: input.workspaceLabel }),
    ],
  );

  return toSummary(row);
}

export async function revokeIntegration(
  db: ScopedDb,
  kind: IntegrationKind,
  reason: string,
  actorUserId: string | null,
): Promise<boolean> {
  const row = await db.maybeOne<{ id: string }>(
    `UPDATE integrations SET revoked_at = now(), revoked_reason = $3
      WHERE project_id = $1 AND kind = $2 AND revoked_at IS NULL
      RETURNING id`,
    [db.projectId, kind, reason.slice(0, 500)],
  );
  if (!row) return false;

  await db.exec(
    `INSERT INTO audit_log (project_id, actor_user_id, action, subject, details)
     VALUES ($1, $2, 'integration.revoked', $3, $4)`,
    [db.projectId, actorUserId, kind, JSON.stringify({ reason })],
  );
  return true;
}

/** What the channel said back, for the settings screen and for M13's monitoring. */
export async function noteIntegrationResult(
  db: ScopedDb,
  integrationId: string,
  outcome: { ok: boolean; error?: string },
): Promise<void> {
  await db.exec(
    `UPDATE integrations
        SET last_delivery_at = CASE WHEN $3 THEN now() ELSE last_delivery_at END,
            last_error = $4
      WHERE project_id = $1 AND id = $2`,
    [
      db.projectId,
      integrationId,
      outcome.ok,
      outcome.ok ? null : (outcome.error ?? '').slice(0, 500),
    ],
  );
}

// --- The OAuth `state` nonce ------------------------------------------------

/** How long an install flow may take. Long enough to pick a channel, not a day. */
export const INSTALL_STATE_TTL_SECONDS = 15 * 60;

function hashState(state: string): Buffer {
  return createHash('sha256').update(state, 'utf8').digest();
}

/**
 * Starts an install: a random `state` for the redirect, hashed in the database.
 *
 * `state` is what stops a stranger linking THEIR Slack channel to someone else's
 * project by sending them a crafted callback URL. Only the hash is stored, because
 * the state itself travels in a URL and URLs end up in logs.
 */
export async function startInstall(
  db: ScopedDb,
  kind: IntegrationKind,
  actorUserId: string | null,
  now: Date,
): Promise<string> {
  const state = randomBytes(32).toString('base64url');
  await db.exec(
    `INSERT INTO integration_installs (project_id, kind, state_hash, started_by, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      db.projectId,
      kind,
      hashState(state),
      actorUserId,
      new Date(now.getTime() + INSTALL_STATE_TTL_SECONDS * 1000),
    ],
  );
  return state;
}

/**
 * Spends the state, once.
 *
 * `used_at IS NULL` in the UPDATE's own WHERE clause rather than a read followed by a
 * write: two callbacks arriving together would both pass a read-then-check, and only
 * one can win an UPDATE.
 */
export async function consumeInstallState(
  db: ScopedDb,
  kind: IntegrationKind,
  state: string,
  now: Date,
): Promise<boolean> {
  const row = await db.maybeOne<{ id: string }>(
    `UPDATE integration_installs SET used_at = $5
      WHERE project_id = $1 AND kind = $2 AND state_hash = $3
        AND used_at IS NULL AND expires_at > $4
      RETURNING id`,
    [db.projectId, kind, hashState(state), now, now],
  );
  return row !== null;
}

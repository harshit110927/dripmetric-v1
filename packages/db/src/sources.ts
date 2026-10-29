import { randomBytes } from 'node:crypto';
import { decryptText, encrypt } from './crypto.js';
import type { ScopedDb, UnscopedDb } from './scope.js';

/**
 * The no-code source feeds (brief §5, M12).
 *
 * Same shape as `integrations.ts` and for the same reasons: the secret is a bearer
 * credential, so it is encrypted at rest and leaves this file in exactly one
 * direction — `liveSourceSecret`, which the webhook handler calls to verify a
 * delivery. The settings screen gets `sourceSummary`, which cannot return it.
 */

export type SourceKind = 'segment' | 'rudderstack' | 'posthog';

export interface SourceSummary {
  id: string;
  kind: SourceKind;
  publicId: string;
  createdAt: Date;
  lastDeliveryAt: Date | null;
  lastOkAt: Date | null;
  lastError: string | null;
  deliveries: number;
  accepted: number;
  dropped: number;
  /** Why things were dropped, most common first. */
  dropReasons: { reason: string; count: number }[];
}

const SUMMARY_COLUMNS = `
  id, kind, public_id, created_at, last_delivery_at, last_ok_at, last_error,
  deliveries, accepted, dropped, drop_reasons
`;

interface SummaryRow {
  id: string;
  kind: SourceKind;
  public_id: string;
  created_at: Date;
  last_delivery_at: Date | null;
  last_ok_at: Date | null;
  last_error: string | null;
  deliveries: string;
  accepted: string;
  dropped: string;
  drop_reasons: Record<string, number>;
}

function toSummary(row: SummaryRow): SourceSummary {
  return {
    id: row.id,
    kind: row.kind,
    publicId: row.public_id,
    createdAt: row.created_at,
    lastDeliveryAt: row.last_delivery_at,
    lastOkAt: row.last_ok_at,
    lastError: row.last_error,
    deliveries: Number(row.deliveries),
    accepted: Number(row.accepted),
    dropped: Number(row.dropped),
    dropReasons: Object.entries(row.drop_reasons)
      .map(([reason, count]) => ({ reason, count: Number(count) }))
      .sort((a, b) => b.count - a.count),
  };
}

export async function sourceSummary(db: ScopedDb): Promise<SourceSummary[]> {
  const rows = await db.query<SummaryRow>(
    `SELECT ${SUMMARY_COLUMNS} FROM sources
      WHERE project_id = $1 AND revoked_at IS NULL
      ORDER BY created_at`,
    [db.projectId],
  );
  return rows.map(toSummary);
}

export interface CreatedSource extends SourceSummary {
  /** Shown once, at creation. Only the ciphertext is kept. */
  secret: string;
}

/**
 * Sets up a source, returning the secret once.
 *
 * The founder pastes the secret into Segment's or PostHog's own settings, so it has
 * to be shown in full exactly once — the same contract as an API key. After this it
 * is a ciphertext and nothing can print it.
 */
export async function createSource(
  db: ScopedDb,
  kind: SourceKind,
  actorUserId: string | null,
): Promise<CreatedSource> {
  const secret = randomBytes(24).toString('base64url');
  const sealed = encrypt(secret);

  // The secret key this source's deliveries will be ingested with.
  const key = await db.maybeOne<{ id: string }>(
    `SELECT id FROM api_keys
      WHERE project_id = $1 AND kind = 'secret' AND mode = 'live' AND revoked_at IS NULL
      ORDER BY created_at LIMIT 1`,
    [db.projectId],
  );

  await db.exec(
    `UPDATE sources SET revoked_at = now()
      WHERE project_id = $1 AND kind = $2 AND revoked_at IS NULL`,
    [db.projectId, kind],
  );

  const row = await db.one<SummaryRow>(
    `INSERT INTO sources
       (project_id, kind, secret_ciphertext, secret_key_id, api_key_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${SUMMARY_COLUMNS}`,
    [db.projectId, kind, sealed.bytes, sealed.keyId, key?.id ?? null, actorUserId],
  );

  await db.exec(
    `INSERT INTO audit_log (project_id, actor_user_id, action, subject)
     VALUES ($1, $2, 'source.created', $3)`,
    [db.projectId, actorUserId, kind],
  );

  return { ...toSummary(row), secret };
}

export interface ResolvedSource {
  sourceId: string;
  projectId: number;
  secret: string;
  /**
   * The api key row this feed is rate-limited against — its ID, not its token.
   *
   * A secret key's token is never stored, only its hash (the
   * `api_keys_secret_is_hashed` constraint), so there is nothing to read back. That
   * is the right design and it means the adapter cannot re-authenticate as the
   * project: instead the verified signature IS the authentication, and this id is
   * what `handleBatch` rate-limits and audits against.
   */
  apiKeyId: string;
  mode: 'live' | 'test';
}

/**
 * Resolves a source by its public id, with the secret and the ingest key.
 *
 * Unscoped, because a webhook arrives with no session and no project — the public id
 * in the URL is what identifies it. This is the only read that returns the secret,
 * and the webhook handler is the only caller.
 */
export async function liveSourceSecret(
  db: UnscopedDb,
  publicId: string,
  kind: SourceKind,
): Promise<ResolvedSource | null> {
  /*
   * A uuid cast that cannot throw.
   *
   * `public_id = $1` against a non-uuid string raises `invalid input syntax for type
   * uuid`, which would turn a probe for `/v1/sources/segment/haxx` into a 500. The
   * regex check keeps it a clean 401.
   */
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(publicId)) {
    return null;
  }

  const row = await db.maybeOne<{
    id: string;
    project_id: number;
    secret_ciphertext: Buffer;
    secret_key_id: string;
    api_key_id: string | null;
    mode: 'live' | 'test';
  }>(
    `SELECT s.id, s.project_id, s.secret_ciphertext, s.secret_key_id,
            k.id AS api_key_id, p.mode
       FROM sources s
       JOIN projects p ON p.id = s.project_id AND p.deleted_at IS NULL
       LEFT JOIN api_keys k ON k.id = s.api_key_id AND k.revoked_at IS NULL
      WHERE s.public_id = $1 AND s.kind = $2 AND s.revoked_at IS NULL`,
    [publicId, kind],
  );
  if (!row) return null;

  /*
   * No usable key means no feed.
   *
   * The source's key was revoked — by a rotation, or by the unclaimed-project sweep
   * — so there is nothing to rate-limit against. Refusing is right: accepting the
   * delivery would let a feed outlive the key it was set up with.
   */
  if (row.api_key_id === null) return null;

  return {
    sourceId: row.id,
    projectId: row.project_id,
    secret: decryptText(row.secret_ciphertext, row.secret_key_id),
    apiKeyId: row.api_key_id,
    mode: row.mode,
  };
}

export interface DeliveryOutcome {
  ok: boolean;
  at: Date;
  accepted?: number;
  dropped?: { reason: string; count: number }[];
  detail?: string;
}

/**
 * Records what a delivery did, including the drop tally.
 *
 * The reasons accumulate in one JSONB object rather than a row per delivery: a
 * founder needs "94% of what PostHog sent was autocapture", not a log of every POST.
 */
export async function recordSourceDelivery(
  db: UnscopedDb,
  sourceId: string,
  outcome: DeliveryOutcome,
): Promise<void> {
  const droppedTotal = (outcome.dropped ?? []).reduce((n, entry) => n + entry.count, 0);
  const increments = Object.fromEntries(
    (outcome.dropped ?? []).map((entry) => [entry.reason, entry.count]),
  );

  await db.exec(
    `UPDATE sources
        SET deliveries = deliveries + 1,
            last_delivery_at = $2,
            last_ok_at = CASE WHEN $3 THEN $2 ELSE last_ok_at END,
            last_error = CASE WHEN $3 THEN NULL ELSE $4 END,
            accepted = accepted + $5,
            dropped = dropped + $6,
            /*
             * Merge the new counts into the existing tally.
             *
             * One statement rather than read-modify-write, so two deliveries landing
             * together cannot lose one of their counts.
             */
            drop_reasons = (
              SELECT coalesce(jsonb_object_agg(key, total), '{}'::jsonb)
                FROM (
                  SELECT key, sum(value::bigint) AS total
                    FROM (
                      SELECT key, value FROM jsonb_each_text(sources.drop_reasons)
                      UNION ALL
                      SELECT key, value FROM jsonb_each_text($7::jsonb)
                    ) merged
                   GROUP BY key
                ) summed
            )
      WHERE id = $1`,
    [
      sourceId,
      outcome.at,
      outcome.ok,
      (outcome.detail ?? '').slice(0, 500),
      outcome.accepted ?? 0,
      droppedTotal,
      JSON.stringify(increments),
    ],
  );
}

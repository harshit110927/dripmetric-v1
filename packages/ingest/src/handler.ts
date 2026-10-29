import {
  BatchBody,
  MAX_BATCH_BYTES,
  MAX_BATCH_MESSAGES,
  RETENTION_DAYS_FREE,
  type MessageResult,
} from '@dripmetric/catalog';
import { currentProject, entitlements, limitOf, withProject, withoutProject } from '@dripmetric/db';
import { extractKey, originAllowed, resolveKey, type ResolvedKey } from './auth.js';
import { IngestError, badRequest, tooLarge, unauthorised, rateLimited } from './errors.js';
import { consumeTokens } from './rate-limit.js';
import { prepareMessage } from './validate.js';
import {
  flushBatch,
  newPipelineState,
  prepareForWrite,
  type FollowUp,
  type ProjectContext,
} from './pipeline/index.js';
import type { IngestRequest, IngestResponse } from './types.js';

/**
 * POST /v1/batch (and /v1/import, the path Segment's Ruby library uses).
 *
 * The reply is a 200 with one result per message unless the whole request is
 * malformed (400), unauthorised (401), too large (413) or rate-limited (429). One
 * bad message never costs a founder the rest of their traffic.
 */

/** Queue adapter, so pg-boss can be swapped (settled decision D3). */
export type EnqueueFollowUps = (projectId: number, followUps: FollowUp[]) => Promise<void>;

export interface HandleBatchOptions {
  enqueue?: EnqueueFollowUps;
  /*
   * An already-authenticated caller (M12's source adapters).
   *
   * A no-code feed proves itself with a signed webhook, not with one of our API keys
   * — and it could not use one even if we wanted it to: a secret key's token is
   * never stored, only its hash (see the `api_keys_secret_is_hashed` constraint), so
   * there is nothing to read back and replay.
   *
   * Passing the resolved key skips token auth and NOTHING else. Rate limiting,
   * validation, dedupe, identity, sessions and the dictionary all still run, so a
   * Segment feed is throttled and audited exactly like an SDK one. That is the whole
   * point of the adapters going through this function instead of around it.
   */
  resolvedKey?: ResolvedKey;
}

export async function handleBatch(
  request: IngestRequest,
  options: HandleBatchOptions = {},
): Promise<IngestResponse> {
  try {
    return await run(request, options);
  } catch (error) {
    if (error instanceof IngestError) {
      return {
        status: error.status,
        body: { error: { code: error.code, message: error.message } },
        ...(Object.keys(error.headers).length > 0 ? { headers: error.headers } : {}),
      };
    }
    throw error;
  }
}

async function run(request: IngestRequest, options: HandleBatchOptions): Promise<IngestResponse> {
  // Read the body as TEXT and parse it here. Browser beacons send `text/plain` to
  // avoid a CORS preflight, so the content type cannot be trusted (brief section 5).
  const size = Buffer.byteLength(request.body, 'utf8');
  if (size > MAX_BATCH_BYTES) {
    throw tooLarge(`This batch is ${size} bytes; the limit is ${MAX_BATCH_BYTES}.`);
  }

  let json: unknown;
  try {
    json = JSON.parse(request.body);
  } catch {
    throw badRequest('invalid_json', 'The body is not valid JSON.');
  }

  const parsed = BatchBody.safeParse(json);
  if (!parsed.success) {
    throw badRequest('invalid_body', 'The body needs a `batch` array of messages.');
  }
  const body = parsed.data;

  if (body.batch.length > MAX_BATCH_MESSAGES) {
    throw tooLarge(
      `A batch may hold ${MAX_BATCH_MESSAGES} messages; this one has ${body.batch.length}.`,
    );
  }

  // --- Step 1: authenticate, then rate-limit ----------------------------------
  // Authentication comes before the empty-batch shortcut below, so an unauthenticated
  // request gets 401 whatever it carries and the endpoint never confirms to someone
  // holding no key that their request was well formed.
  let key: ResolvedKey;
  if (options.resolvedKey) {
    key = options.resolvedKey;
  } else {
    const token = extractKey(request, body.writeKey);
    if (!token)
      throw unauthorised(
        'No API key. Send it as a bearer token, as the Basic-auth username, or as `writeKey` in the body.',
      );
    key = await resolveKey(token);
  }

  const decision = await withoutProject('resolve-api-key', (db) =>
    consumeTokens(
      db,
      key.apiKeyId,
      key.projectId,
      Math.max(1, body.batch.length),
      request.receivedAt,
    ),
  );
  if (!decision.allowed) throw rateLimited(decision.retryAfterSeconds);

  if (body.batch.length === 0) {
    return { status: 200, body: { results: [], accepted: 0 } };
  }

  // --- The project's own settings ---------------------------------------------
  const setup = await withProject(key.projectId, async (db) => {
    const project = await currentProject(db);
    const plan = await entitlements(db);
    return { project, retentionDays: limitOf(plan, 'retention_days') || RETENTION_DAYS_FREE };
  });

  if (!originAllowed(key.kind, request.headers['origin'], setup.project.settings.allowedOrigins)) {
    throw unauthorised('That origin is not on this project’s allow-list.');
  }

  // --- Steps 2 and 3: validate, then write ------------------------------------
  const batchSentAt = body.sentAt ? new Date(body.sentAt) : null;
  // Indexed by batch position, so the reply lists results in the order they arrived
  // even for a message so malformed that it has no id to sort by.
  const results: (MessageResult | undefined)[] = new Array(body.batch.length);
  const state = newPipelineState();

  const context: ProjectContext = {
    projectId: key.projectId,
    // Only a secret key may set server-only traits or send billing events.
    allowServerOnly: key.kind === 'secret',
    // A publishable key is a browser; a secret key is a server. An explicit source
    // only comes from the no-code feed adapters (M12).
    source: request.source ?? (key.kind === 'secret' ? 'server' : 'browser'),
    internalDomains: setup.project.settings.internalDomains,
    internalEmails: setup.project.settings.internalEmails,
    dailyRowsPerUserPerEvent: setup.project.settings.dailyRowsPerUserPerEvent,
    // Country from the platform's IP header; the IP is never stored (brief section 5).
    country: countryFrom(request.headers),
    userAgent: request.headers['user-agent'],
  };

  await withProject(key.projectId, async (db) => {
    // Phase one: per message. Every lookup is cached for the batch, so 1,000 events
    // from 100 people cost 100 user lookups rather than 1,000.
    for (const [index, raw] of body.batch.entries()) {
      const prepared = prepareMessage(raw, {
        receivedAt: request.receivedAt,
        batchSentAt,
        retentionDays: setup.retentionDays,
      });

      if (!prepared.ok) {
        results[index] = prepared.result;
        continue;
      }

      // A null result means the message is queued for the batch write below.
      const settled = await prepareForWrite(
        db,
        index,
        prepared.message,
        context,
        state,
        request.receivedAt,
      );
      if (settled) results[index] = settled;
    }

    // Phase two: one multi-row insert each for the events, the step state, the
    // tracked-user rows and the daily counters (brief section 3: batched inserts).
    for (const written of await flushBatch(db, state, context)) {
      results[written.index] = written.result;
    }
  });

  const settledResults = results.filter((r): r is MessageResult => r !== undefined);

  // --- Step 9: queue the heavy work, after the transaction commits -------------
  if (options.enqueue && state.followUps.length > 0) {
    await options.enqueue(key.projectId, dedupeFollowUps(state.followUps));
  }

  await touchKey(key.apiKeyId, request.receivedAt);

  return {
    status: 200,
    body: {
      results: settledResults,
      accepted: settledResults.filter((r) => r.status === 'ok').length,
    },
  };
}

/** Vercel sets `x-vercel-ip-country`; other platforms use their own header. */
function countryFrom(headers: Readonly<Record<string, string | undefined>>): string | null {
  const value =
    headers['x-vercel-ip-country'] ?? headers['cf-ipcountry'] ?? headers['x-country-code'] ?? null;
  if (!value || value === 'XX') return null;
  return value.slice(0, 2).toUpperCase();
}

function dedupeFollowUps(followUps: FollowUp[]): FollowUp[] {
  const seen = new Set<string>();
  return followUps.filter((f) => {
    const key = `${f.job}:${f.userKey}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function touchKey(apiKeyId: string, at: Date): Promise<void> {
  await withoutProject('resolve-api-key', (db) =>
    db.exec('UPDATE api_keys SET last_used_at = $2 WHERE id = $1', [apiKeyId, at]),
  );
}

/** CORS for the browser SDK. Publishable keys are origin-restricted separately. */
export function corsHeaders(
  origin: string | undefined,
  allowedOrigins: readonly string[],
): Record<string, string> {
  const allow = allowedOrigins.length === 0 || !origin ? (origin ?? '*') : origin;
  return {
    'access-control-allow-origin': allow,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-max-age': '86400',
    vary: 'Origin',
  };
}

import {
  liveSourceSecret,
  recordSourceDelivery,
  withoutProject,
  type UnscopedDb,
} from '@dripmetric/db';
import { handleBatch } from '../handler.js';
import { IngestError } from '../errors.js';
import type { IngestRequest, IngestResponse } from '../types.js';
import {
  normalisePostHog,
  normaliseSegmentLike,
  type AdapterSource,
  type NormaliseResult,
} from './normalise.js';
import { verifySegmentSignature, verifyStaticSecret } from './signatures.js';

/**
 * The no-code webhook endpoint (brief §5, M12).
 *
 * One handler for all three feeds. It does three things in order and then gets out of
 * the way: prove the delivery came from the tool, turn its payload into our messages,
 * and hand them to the SAME `handleBatch` the SDK uses.
 *
 * That last part is the design. There is one pipeline, one dedupe, one set of rules
 * about what an event means — so a founder on Segment and a founder on our own SDK
 * cannot get different answers, and a fix to the pipeline fixes every path at once.
 */

export interface WebhookRequest {
  /** The raw body, unparsed: a signature is over bytes, not over a re-serialisation. */
  rawBody: string;
  headers: Record<string, string | undefined>;
  receivedAt: Date;
}

/** Which header each tool's secret arrives in. */
const SIGNATURE_HEADERS: Record<AdapterSource, string> = {
  segment: 'x-signature',
  // RudderStack and PostHog do not sign; the founder sets a static header.
  rudderstack: 'authorization',
  posthog: 'authorization',
};

export async function handleSourceWebhook(
  source: AdapterSource,
  publicSourceId: string,
  request: WebhookRequest,
): Promise<IngestResponse> {
  const resolved = await withoutProject('resolve-api-key', (db: UnscopedDb) =>
    liveSourceSecret(db, publicSourceId, source),
  );

  /*
   * An unknown source id is a 401, not a 404.
   *
   * A 404 would tell whoever is probing that this id does not exist, and a 200 for a
   * valid id would then tell them which ones do. Both answers are the same shape.
   */
  if (!resolved) {
    throw new IngestError(401, 'unauthorised', 'That source is not set up, or has been removed.');
  }

  const header = request.headers[SIGNATURE_HEADERS[source]] ?? null;
  const check =
    source === 'segment'
      ? verifySegmentSignature(request.rawBody, header, resolved.secret)
      : verifyStaticSecret(header, resolved.secret);

  if (!check.ok) {
    // The reason is recorded for the founder's own settings screen, never returned.
    await withoutProject('resolve-api-key', (db) =>
      recordSourceDelivery(db, resolved.sourceId, {
        ok: false,
        at: request.receivedAt,
        detail: check.because,
      }),
    );
    throw new IngestError(401, 'unauthorised', 'The signature on that delivery did not match.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(request.rawBody);
  } catch {
    throw new IngestError(400, 'invalid_json', 'That delivery was not valid JSON.');
  }

  const normalised: NormaliseResult =
    source === 'posthog' ? normalisePostHog(parsed) : normaliseSegmentLike(parsed, source);

  await withoutProject('resolve-api-key', (db) =>
    recordSourceDelivery(db, resolved.sourceId, {
      ok: true,
      at: request.receivedAt,
      accepted: normalised.messages.length,
      dropped: normalised.dropped,
    }),
  );

  /*
   * Nothing to forward is a 200, not an error.
   *
   * A PostHog delivery that was entirely autocapture is a successful delivery of
   * nothing we want. Answering 4xx would make the tool retry it forever.
   */
  if (normalised.messages.length === 0) {
    return {
      status: 200,
      body: { accepted: 0, dropped: normalised.dropped },
    };
  }

  /*
   * Through the front door, with the signature standing in for the key.
   *
   * The adapter could call the pipeline directly, but then it would be a second way
   * in — its own rate limiting, its own idea of a batch, its own bugs. So it reuses
   * the real entry point and passes the key it has already resolved.
   *
   * It passes the key's ID rather than a token because a secret key's token is never
   * stored, only its hash. That is deliberate and worth keeping: it means a leak of
   * this table cannot be replayed as a valid API key. The verified webhook signature
   * is what authenticates the delivery.
   */
  const inner: IngestRequest = {
    body: JSON.stringify({ batch: normalised.messages }),
    headers: {
      'content-type': 'application/json',
      // No user agent: these arrive from a server, and a browser-shaped one would
      // make the bot filter and the device enrichment lie.
    },
    /*
     * The events are recorded as coming from THIS tool, not as generic server sends.
     *
     * Without it the pipeline derives the source from the key kind, so a Segment feed
     * and a founder's own server SDK both store `server` — and the double-path
     * warning, which looks for one action arriving from two sources in the same
     * second, can never fire. The whole point of wiring a feed is knowing where
     * events came from.
     */
    source,
    receivedAt: request.receivedAt,
  };

  const response = await handleBatch(inner, {
    resolvedKey: {
      apiKeyId: resolved.apiKeyId,
      projectId: resolved.projectId,
      // Server-sent: a feed arrives from a tool's backend, never from a browser.
      kind: 'secret',
      mode: resolved.mode,
    },
  });
  const body = response.body as Record<string, unknown>;

  return {
    status: response.status,
    body: { ...body, dropped: normalised.dropped },
  };
}

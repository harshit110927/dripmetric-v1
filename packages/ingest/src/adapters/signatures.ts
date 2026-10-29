import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verifying that a no-code feed really came from the tool it claims (brief §5).
 *
 * M12's exit check is "a bad signature gets 401", and the interesting part is that
 * each tool signs something slightly different. Getting that wrong fails closed,
 * which is the safe direction but also means a founder's working integration
 * silently stops — so each scheme is written down with where it came from.
 *
 * Verified against the live docs on 2026-10-29:
 *
 *   Segment: the shared secret produces an HMAC in `X-Signature`, "a hex-encoded
 *   SHA1 hash generated using the shared secret and the request body".
 *   https://www.twilio.com/docs/segment/connections/destinations/catalog/actions-webhook
 *
 *   AND the part that is easy to miss: with batching enabled, Segment signs THE
 *   FIRST EVENT IN THE BATCH, not the whole batch. A verifier that hashes the whole
 *   body rejects every batched delivery, which looks exactly like a wrong secret.
 */

export type SignatureAlgorithm = 'sha1' | 'sha256';

export interface SignatureCheck {
  ok: boolean;
  /** Why it failed, for the log. Never returned to the caller verbatim. */
  because: string;
}

/**
 * Constant-time compare of two hex digests.
 *
 * `timingSafeEqual` throws on a length mismatch, which a bad signature often is, so
 * the lengths are checked first — and a mismatch is a plain false rather than an
 * exception that would become a 500 and look like our bug.
 */
function sameHex(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  if (left.length === 0 || left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function hmacHex(algorithm: SignatureAlgorithm, secret: string, body: string): string {
  return createHmac(algorithm, secret).update(body, 'utf8').digest('hex');
}

/**
 * Segment's scheme, both shapes.
 *
 * The whole body is tried first and the first event second, because a founder who has
 * not enabled batching is the common case and should not pay for a JSON parse on
 * every request. Both are accepted: we cannot see the destination's batching setting
 * from here, and refusing the other shape would mean the integration breaks the day
 * they turn batching on.
 */
export function verifySegmentSignature(
  rawBody: string,
  header: string | null,
  secret: string,
): SignatureCheck {
  if (!header) return { ok: false, because: 'No X-Signature header.' };
  if (!secret) return { ok: false, because: 'No shared secret is configured for this source.' };

  if (sameHex(hmacHex('sha1', secret, rawBody), header)) {
    return { ok: true, because: 'Signed over the whole body.' };
  }

  // Batched: Segment signs the first event only.
  const first = firstEventOf(rawBody);
  if (first !== null && sameHex(hmacHex('sha1', secret, first), header)) {
    return { ok: true, because: 'Signed over the first event of a batch.' };
  }

  return { ok: false, because: 'The signature does not match the shared secret.' };
}

/**
 * The first event of a batch, re-serialised.
 *
 * This is the part that cannot be made exact from our side: Segment hashes the bytes
 * IT serialised, and `JSON.stringify` of a parsed object need not reproduce them
 * byte for byte (key order is preserved by V8 for string keys, but whitespace and
 * number formatting are not guaranteed to match). It works for Segment's own output
 * and is the documented approach; if a founder's batched deliveries ever fail
 * verification, this is the line to suspect, and `docs/runbook.md` says so.
 */
function firstEventOf(rawBody: string): string | null {
  try {
    const parsed: unknown = JSON.parse(rawBody);
    const first = Array.isArray(parsed)
      ? parsed[0]
      : typeof parsed === 'object' &&
          parsed !== null &&
          Array.isArray((parsed as { batch?: unknown[] }).batch)
        ? (parsed as { batch: unknown[] }).batch[0]
        : null;
    return first === null || first === undefined ? null : JSON.stringify(first);
  } catch {
    return null;
  }
}

/**
 * RudderStack's webhook destination.
 *
 * It does not sign: it forwards the event to a URL and lets you add your own static
 * headers. So the shared secret IS a header value, compared in constant time — which
 * is weaker than a signature and is why the header name and value are both the
 * founder's to choose and are stored encrypted like any other credential.
 */
export function verifyStaticSecret(provided: string | null, expected: string): SignatureCheck {
  if (!provided) return { ok: false, because: 'No authentication header.' };
  if (!expected) return { ok: false, because: 'No shared secret is configured for this source.' };

  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, because: 'The shared secret does not match.' };
  }
  return { ok: true, because: 'Static secret matched.' };
}

/**
 * A generic HMAC verifier, for a tool that signs the raw body.
 *
 * PostHog's destinations post whatever template you give them and carry no signature
 * of their own, so a founder wiring PostHog sets a secret header — the same shape as
 * RudderStack. This exists for the tools that do sign, so adding one later is a
 * configuration change rather than a new verifier.
 */
export function verifyBodyHmac(
  rawBody: string,
  header: string | null,
  secret: string,
  algorithm: SignatureAlgorithm = 'sha256',
): SignatureCheck {
  if (!header) return { ok: false, because: 'No signature header.' };
  if (!secret) return { ok: false, because: 'No shared secret is configured for this source.' };
  // Some tools prefix the digest, e.g. `sha256=...`.
  const digest = header.includes('=') ? (header.split('=').pop() ?? '') : header;
  return sameHex(hmacHex(algorithm, secret, rawBody), digest)
    ? { ok: true, because: 'Signature matched.' }
    : { ok: false, because: 'The signature does not match the shared secret.' };
}

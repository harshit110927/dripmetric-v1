import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closePools, withProject } from '@dripmetric/db';
import { MAX_BATCH_BYTES, MAX_MESSAGE_BYTES } from '@dripmetric/catalog';
import {
  adminClient,
  ensureMigrated,
  newFixture,
  postBatch,
  postRaw,
  reply,
  resetData,
  track,
  type Fixture,
} from './helpers.js';

/** A real browser's user agent: a curl-shaped one is correctly filtered as a bot. */
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36';

/**
 * M1 exit checks (brief section 11), one test each. Every assertion here is a line
 * from the brief, so a failure says which promise broke.
 */
describe('POST /v1/batch', () => {
  let fx: Fixture;

  beforeAll(ensureMigrated);
  beforeEach(async () => {
    await resetData();
    fx = await newFixture();
  });
  afterAll(closePools);

  it('returns a per-message result for the curl example in Appendix B', async () => {
    const response = await postBatch(
      [
        {
          type: 'track',
          messageId: '0192b3a4-5c6d-7e8f-9a0b-1c2d3e4f5a6b',
          userId: 'user_123',
          event: 'Checkout Started',
          properties: { plan: 'pro', amount: 2900, currency: 'usd' },
          timestamp: '2026-09-29T10:15:00Z',
        },
      ],
      { key: fx.secretKey, receivedAt: new Date('2026-09-29T10:15:02Z') },
    );

    expect(response.status).toBe(200);
    const body = reply(response);
    expect(body.accepted).toBe(1);
    expect(body.results).toEqual([
      { messageId: '0192b3a4-5c6d-7e8f-9a0b-1c2d3e4f5a6b', status: 'ok', code: 'ok' },
    ]);
  });

  it('changes nothing when the same batch is replayed', async () => {
    const batch = [track('Signed Up', { messageId: 'replay-1' })];
    const at = new Date('2026-09-29T10:15:00Z');

    const first = await postBatch(batch, { key: fx.secretKey, receivedAt: at });
    expect(reply(first).results[0]?.status).toBe('ok');

    const second = await postBatch(batch, { key: fx.secretKey, receivedAt: at });
    expect(reply(second).results[0]?.status).toBe('duplicate');

    const rows = await withProject(fx.project.live.id, (db) =>
      db.query<{ count: string }>('SELECT count(*) FROM events'),
    );
    expect(rows[0]?.count).toBe('1');
  });

  it('reports the second copy of a messageId IN THE SAME BATCH as a duplicate', async () => {
    // Found by the simulator's `duplicates` fault. Postgres's ON CONFLICT DO NOTHING
    // inserts the first of two identical keys in one statement and skips the second
    // without saying so, so both pending rows used to look like they had landed and
    // both were reported 'ok' for a single stored row. A client retrying inside one
    // batch would never learn its retry had been collapsed.
    const message = track('Core Action', { messageId: 'same-id-twice' });

    const response = await postBatch([message, { ...message }], { key: fx.secretKey });
    const body = reply(response);

    expect(body.results.map((r) => r.status)).toEqual(['ok', 'duplicate']);
    expect(body.accepted).toBe(1);

    const rows = await withProject(fx.project.live.id, (db) =>
      db.query<{ count: string }>('SELECT count(*) FROM events'),
    );
    expect(rows[0]?.count).toBe('1');
  });

  it('still counts a within-batch duplicate toward the daily volume guard', async () => {
    // The cap is a guard against a runaway loop, so it has to count what ARRIVED.
    // A retry storm is exactly the volume it exists to notice.
    const message = track('Core Action', { messageId: 'retry-storm-1' });
    await postBatch([message, { ...message }, { ...message }], { key: fx.secretKey });

    const counts = await withProject(fx.project.live.id, (db) =>
      db.query<{ total_count: number }>('SELECT total_count FROM daily_event_counts'),
    );
    expect(counts[0]?.total_count).toBe(3);
  });

  it('returns 200 with one error when a single message in the batch is bad', async () => {
    const response = await postBatch(
      [
        track('Signed Up', { messageId: 'good-1' }),
        // No messageId at all: a retry of this could never be deduped.
        { type: 'track', userId: 'user_123', event: 'Activated' },
        track('Activated', { messageId: 'good-2' }),
      ],
      { key: fx.secretKey },
    );

    expect(response.status).toBe(200);
    const body = reply(response);
    expect(body.accepted).toBe(2);
    expect(body.results.filter((r) => r.status === 'error')).toHaveLength(1);
    expect(body.results[1]?.code).toBe('invalid_message');
  });

  it('refuses a batch over 500 KB with 413', async () => {
    const padding = 'x'.repeat(1024);
    const batch = Array.from({ length: 700 }, (_, i) =>
      track('Core Action', { messageId: `big-${i}`, properties: { padding } }),
    );
    const body = JSON.stringify({ batch });
    expect(Buffer.byteLength(body)).toBeGreaterThan(MAX_BATCH_BYTES);

    const response = await postRaw(body, { key: fx.secretKey });
    expect(response.status).toBe(413);
  });

  it('errors one oversized message alone, leaving the rest of the batch alive', async () => {
    const response = await postBatch(
      [
        track('Signed Up', { messageId: 'small-1' }),
        track('Core Action', {
          messageId: 'huge-1',
          properties: { blob: 'x'.repeat(MAX_MESSAGE_BYTES + 1000) },
        }),
      ],
      { key: fx.secretKey },
    );

    expect(response.status).toBe(200);
    const body = reply(response);
    expect(body.results[0]?.status).toBe('ok');
    expect(body.results[1]?.code).toBe('message_too_large');
    expect(body.accepted).toBe(1);
  });

  it('refuses a publishable key that tries to set stripeCustomerId', async () => {
    const response = await postBatch(
      [
        {
          type: 'identify',
          messageId: 'id-1',
          userId: 'user_123',
          traits: { email: 'a@acme.com', stripeCustomerId: 'cus_forged' },
        },
      ],
      { key: fx.publishableKey },
    );

    const body = reply(response);
    expect(body.results[0]?.code).toBe('server_only_trait');
    expect(body.results[0]?.message).toContain('secret key');

    const rows = await withProject(fx.project.live.id, (db) =>
      db.query('SELECT stripe_customer_id FROM end_users WHERE stripe_customer_id IS NOT NULL'),
    );
    expect(rows).toHaveLength(0);
  });

  it('accepts stripeCustomerId from a secret key', async () => {
    const response = await postBatch(
      [
        {
          type: 'identify',
          messageId: 'id-2',
          userId: 'user_123',
          traits: { email: 'a@acme.com', stripeCustomerId: 'cus_real' },
        },
      ],
      { key: fx.secretKey },
    );

    expect(reply(response).results[0]?.status).toBe('ok');
    const rows = await withProject(fx.project.live.id, (db) =>
      db.query<{ stripe_customer_id: string }>('SELECT stripe_customer_id FROM end_users'),
    );
    expect(rows[0]?.stripe_customer_id).toBe('cus_real');
  });

  it('refuses a billing event from a publishable key', async () => {
    const response = await postBatch(
      [track('Subscription Started', { messageId: 'bill-1', properties: { amount: 2900 } })],
      { key: fx.publishableKey },
    );
    expect(reply(response).results[0]?.code).toBe('server_only_event');
  });

  it('tags a billing event sent with a secret key as source=billing', async () => {
    await postBatch(
      [
        track('Subscription Started', {
          messageId: 'bill-2',
          properties: { amount: 2900, currency: 'usd' },
        }),
      ],
      { key: fx.secretKey },
    );

    const rows = await withProject(fx.project.live.id, (db) =>
      db.query<{ source: number }>('SELECT source FROM events'),
    );
    // SOURCES = [browser, server, segment, rudderstack, posthog, billing]
    expect(rows[0]?.source).toBe(5);
  });

  it('refuses a publishable key from an origin that is not on the allow-list', async () => {
    await withProject(fx.project.live.id, (db) =>
      db.exec(
        `UPDATE projects SET settings = settings || '{"allowedOrigins":["https://acme.com"]}'::jsonb WHERE id = $1`,
        [fx.project.live.id],
      ),
    );

    const refused = await postBatch([track('Signed Up')], {
      key: fx.publishableKey,
      origin: 'https://evil.example',
    });
    expect(refused.status).toBe(401);

    const allowed = await postBatch([track('Signed Up')], {
      key: fx.publishableKey,
      origin: 'https://acme.com',
    });
    expect(allowed.status).toBe(200);
  });

  it('does not origin-check a secret key, because a server sends no Origin', async () => {
    await withProject(fx.project.live.id, (db) =>
      db.exec(
        `UPDATE projects SET settings = settings || '{"allowedOrigins":["https://acme.com"]}'::jsonb WHERE id = $1`,
        [fx.project.live.id],
      ),
    );
    const response = await postBatch([track('Signed Up')], { key: fx.secretKey });
    expect(response.status).toBe(200);
  });

  it('returns 429 with Retry-After once the bucket is empty', async () => {
    const at = new Date('2026-09-29T10:00:00Z');
    // The bucket holds 2000 tokens; three batches of 900 spend 2700 with no refill.
    for (const i of [0, 1]) {
      const batch = Array.from({ length: 900 }, (_, n) =>
        track('Core Action', { messageId: `rl-${i}-${n}` }),
      );
      await postBatch(batch, { key: fx.secretKey, receivedAt: at });
    }
    const third = Array.from({ length: 900 }, (_, n) =>
      track('Core Action', { messageId: `rl-2-${n}` }),
    );
    const response = await postBatch(third, { key: fx.secretKey, receivedAt: at });

    expect(response.status).toBe(429);
    expect(response.headers?.['retry-after']).toMatch(/^\d+$/);
    expect(Number(response.headers?.['retry-after'])).toBeGreaterThan(0);
  });

  it('accepts a text/plain beacon body with the key inside it', async () => {
    // `sendBeacon` cannot set headers, so the key travels in the body and the content
    // type is text/plain to avoid a CORS preflight (brief section 5).
    const response = await postRaw(
      JSON.stringify({
        batch: [track('Page Viewed', { messageId: 'beacon-1', anonymousId: 'anon_1' })],
        writeKey: fx.publishableKey,
      }),
      { contentType: 'text/plain', noAuthHeader: true },
    );

    expect(response.status).toBe(200);
    expect(reply(response).accepted).toBe(1);
  });

  it('accepts the key as the Basic-auth username, the way Segment’s libraries send it', async () => {
    const response = await postBatch([track('Signed Up', { messageId: 'basic-1' })], {
      key: fx.secretKey,
      basic: true,
    });
    expect(response.status).toBe(200);
    expect(reply(response).accepted).toBe(1);
  });

  it('refuses a missing or unknown key with 401', async () => {
    expect((await postBatch([track('Signed Up')], {})).status).toBe(401);
    expect(
      (await postBatch([track('Signed Up')], { key: 'sk_live_notarealkeyatall1234' })).status,
    ).toBe(401);
    expect((await postBatch([track('Signed Up')], { key: 'garbage' })).status).toBe(401);
  });

  it('refuses a malformed body with 400', async () => {
    expect((await postRaw('not json at all', { key: fx.secretKey })).status).toBe(400);
    expect((await postRaw('{"nope":1}', { key: fx.secretKey })).status).toBe(400);
  });

  it('drops a known crawler without counting it', async () => {
    const response = await postBatch([track('Page Viewed', { messageId: 'bot-1' })], {
      key: fx.publishableKey,
      userAgent: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    });
    expect(reply(response).results[0]?.code).toBe('bot_filtered');

    const rows = await withProject(fx.project.live.id, (db) => db.query('SELECT 1 FROM events'));
    expect(rows).toHaveLength(0);
  });

  it('keeps the founder’s own team out of every number', async () => {
    await withProject(fx.project.live.id, (db) =>
      db.exec(
        `UPDATE projects SET settings = settings || '{"internalDomains":["acme.com"]}'::jsonb WHERE id = $1`,
        [fx.project.live.id],
      ),
    );

    const identified = await postBatch(
      [
        {
          type: 'identify',
          messageId: 'int-1',
          userId: 'founder_1',
          traits: { email: 'me@acme.com' },
        },
      ],
      { key: fx.secretKey },
    );
    expect(reply(identified).results[0]?.code).toBe('internal_filtered');

    // And every later event from that person is filtered too.
    const later = await postBatch(
      [track('Activated', { messageId: 'int-2', userId: 'founder_1' })],
      {
        key: fx.secretKey,
      },
    );
    expect(reply(later).results[0]?.code).toBe('internal_filtered');
  });

  it('removes what was already stored when an identify reveals an internal address', async () => {
    // The identify can arrive AFTER an event from the same person: the simulator
    // found a step event and an identify sharing a millisecond, with the id tiebreak
    // putting the event first. Leaving the row means any query that forgets to
    // filter on `internal` counts the founder's own team.
    await withProject(fx.project.live.id, (db) =>
      db.exec(
        `UPDATE projects SET settings = settings || '{"internalDomains":["acme.com"]}'::jsonb WHERE id = $1`,
        [fx.project.live.id],
      ),
    );

    // An event lands first, under a person we know nothing about yet.
    const first = await postBatch(
      [track('Activated', { messageId: 'pre-1', userId: 'founder_2' })],
      {
        key: fx.secretKey,
      },
    );
    expect(reply(first).results[0]?.status).toBe('ok');

    const before = await withProject(fx.project.live.id, (db) =>
      db.query<{ count: string }>('SELECT count(*) FROM events'),
    );
    expect(before[0]?.count).toBe('1');

    // Then the identify reveals they are internal.
    await postBatch(
      [
        {
          type: 'identify',
          messageId: 'pre-2',
          userId: 'founder_2',
          traits: { email: 'me@acme.com' },
        },
      ],
      { key: fx.secretKey },
    );

    const after = await withProject(fx.project.live.id, (db) =>
      db.query<{ count: string }>('SELECT count(*) FROM events'),
    );
    expect(after[0]?.count).toBe('0');
  });

  it('drops rows queued earlier in the SAME batch for an internal person', async () => {
    await withProject(fx.project.live.id, (db) =>
      db.exec(
        `UPDATE projects SET settings = settings || '{"internalDomains":["acme.com"]}'::jsonb WHERE id = $1`,
        [fx.project.live.id],
      ),
    );

    await postBatch(
      [
        track('Activated', { messageId: 'batch-pre-1', userId: 'founder_3' }),
        {
          type: 'identify',
          messageId: 'batch-pre-2',
          userId: 'founder_3',
          traits: { email: 'me@acme.com' },
        },
        track('Core Action', { messageId: 'batch-pre-3', userId: 'founder_3' }),
      ],
      { key: fx.secretKey },
    );

    const rows = await withProject(fx.project.live.id, (db) =>
      db.query<{ count: string }>('SELECT count(*) FROM events'),
    );
    expect(rows[0]?.count).toBe('0');
  });

  it('takes the country from the platform header and never stores an IP', async () => {
    await postBatch(
      [
        {
          type: 'page',
          messageId: 'geo-1',
          anonymousId: 'anon_geo',
          context: { sessionId: 'sess_geo', page: { path: '/pricing' }, ip: '203.0.113.9' },
        },
      ],
      { key: fx.publishableKey, country: 'DE' },
    );

    const sessions = await withProject(fx.project.live.id, (db) =>
      db.query<{ country: string }>('SELECT country FROM sessions'),
    );
    expect(sessions[0]?.country).toBe('DE');

    // The IP was in the message and must appear nowhere in the database.
    const client = await adminClient();
    try {
      const { rows } = await client.query<{ hits: string }>(
        `SELECT count(*) AS hits FROM events WHERE props::text LIKE '%203.0.113.9%'`,
      );
      expect(rows[0]?.hits).toBe('0');
    } finally {
      await client.end();
    }
  });

  it('flags a late event instead of rejecting it', async () => {
    const happened = new Date('2026-09-29T10:00:00Z');
    const received = new Date('2026-09-29T14:00:00Z'); // four hours later

    await postBatch(
      [track('Core Action', { messageId: 'late-1', timestamp: happened.toISOString() })],
      { key: fx.secretKey, receivedAt: received, sentAt: received.toISOString() },
    );

    const rows = await withProject(fx.project.live.id, (db) =>
      db.query<{ flags: number; occurred_at: Date }>('SELECT flags, occurred_at FROM events'),
    );
    expect(rows[0]?.flags).toBe(1); // FLAG_LATE
    expect(rows[0]?.occurred_at.toISOString()).toBe(happened.toISOString());
  });

  it('rejects a timestamp more than 24 hours in the future', async () => {
    const now = new Date('2026-09-29T10:00:00Z');
    const response = await postBatch(
      [track('Core Action', { messageId: 'future-1', timestamp: '2026-10-05T10:00:00Z' })],
      { key: fx.secretKey, receivedAt: now, sentAt: now.toISOString() },
    );
    expect(reply(response).results[0]?.code).toBe('timestamp_too_far_future');
  });

  it('counts instead of storing once one person passes the daily cap', async () => {
    await withProject(fx.project.live.id, (db) =>
      db.exec(
        `UPDATE projects SET settings = settings || '{"dailyRowsPerUserPerEvent":3}'::jsonb WHERE id = $1`,
        [fx.project.live.id],
      ),
    );

    const at = new Date('2026-09-29T10:00:00Z');
    const batch = Array.from({ length: 5 }, (_, i) =>
      track('Core Action', { messageId: `cap-${i}`, timestamp: at.toISOString() }),
    );
    const response = await postBatch(batch, {
      key: fx.secretKey,
      receivedAt: at,
      sentAt: at.toISOString(),
    });

    const body = reply(response);
    expect(body.results.filter((r) => r.status === 'ok')).toHaveLength(3);
    expect(body.results.filter((r) => r.code === 'daily_cap_reached')).toHaveLength(2);

    const counts = await withProject(fx.project.live.id, (db) =>
      db.query<{ stored_count: number; overflow_count: number }>(
        'SELECT stored_count, overflow_count FROM daily_event_counts',
      ),
    );
    expect(counts[0]?.stored_count).toBe(3);
    expect(counts[0]?.overflow_count).toBe(2);
  });

  it('records one tracked-user row per person per month', async () => {
    const at = new Date('2026-09-29T10:00:00Z');
    await postBatch(
      [
        track('Signed Up', { messageId: 'mau-1', timestamp: at.toISOString() }),
        track('Activated', { messageId: 'mau-2', timestamp: at.toISOString() }),
        track('Core Action', {
          messageId: 'mau-3',
          userId: 'user_456',
          timestamp: at.toISOString(),
        }),
      ],
      { key: fx.secretKey, receivedAt: at, sentAt: at.toISOString() },
    );

    const rows = await withProject(fx.project.live.id, (db) =>
      db.query<{ month: Date; user_key: number }>(
        'SELECT month, user_key FROM monthly_active_users',
      ),
    );
    expect(rows).toHaveLength(2); // two people, one row each, not one per event
  });
});

/**
 * The browser SDK sends a page LEAVE as `{type: 'page', name: 'Page Left'}` with the
 * running totals attached (brief §6, `packages/sdk/src/browser/client.ts`).
 *
 * Ingest used to ignore that `name` and store every page message as `Page Viewed`,
 * which was wrong in three ways at once and shipped from M1 to M7:
 *
 *  - no `Page Left` was ever recorded from the SDK, so step timing's active seconds
 *    and the pricing attention time were unreachable, and the intent engine's
 *    pricing signals could not fire at all;
 *  - `updatePageLeftTotals` never ran, so a repeat page leave was dropped as a
 *    duplicate instead of raising the totals — and a page leave's messageId is
 *    deterministic (`pl-<pageViewId>`) precisely so it can be re-sent;
 *  - every page view was counted twice, once for the view and once for the leave.
 */
describe('a page message carrying an event name', () => {
  beforeAll(ensureMigrated, 60_000);
  beforeEach(resetData);
  afterAll(closePools);

  it('stores Page Left as Page Left, not as a second Page Viewed', async () => {
    const { project, publishableKey } = await newFixture();

    await postBatch(
      [
        {
          type: 'page',
          messageId: 'pv-1',
          anonymousId: 'anon-1',
          properties: { path: '/pricing' },
          context: { page: { path: '/pricing' }, sessionId: 's-1' },
        },
        {
          type: 'page',
          name: 'Page Left',
          messageId: 'pl-1',
          anonymousId: 'anon-1',
          properties: { path: '/pricing', activeSeconds: 42, deepestScroll: 80, pageViewId: 'pv1' },
          context: { page: { path: '/pricing' }, sessionId: 's-1' },
        },
      ],
      { key: publishableKey, userAgent: BROWSER_UA },
    );

    const rows = await withProject(project.live.id, (db) =>
      db.query<{ raw_name: string; active: string | null }>(
        `SELECT n.raw_name, e.props->>'activeSeconds' AS active
           FROM events e
           JOIN event_names n ON n.project_id = e.project_id AND n.id = e.name_id
          WHERE e.project_id = $1
          ORDER BY n.raw_name`,
        [db.projectId],
      ),
    );

    expect(rows.map((r) => r.raw_name)).toEqual(['Page Left', 'Page Viewed']);
    expect(rows[0]!.active).toBe('42');
  });

  it('keeps a Segment page NAME as a page view, with the name in its properties', async () => {
    // Segment's `page` call uses `name` for the page's name, not an event name
    // (settled decision 11), so "Pricing" must not become an event called Pricing.
    const { project, publishableKey } = await newFixture();

    await postBatch(
      [
        {
          type: 'page',
          name: 'Pricing',
          messageId: 'seg-1',
          anonymousId: 'anon-2',
          properties: { path: '/pricing' },
          context: { page: { path: '/pricing' }, sessionId: 's-2' },
        },
      ],
      { key: publishableKey, userAgent: BROWSER_UA },
    );

    const names = await withProject(project.live.id, (db) =>
      db.query<{ raw_name: string }>(
        `SELECT n.raw_name FROM events e
           JOIN event_names n ON n.project_id = e.project_id AND n.id = e.name_id
          WHERE e.project_id = $1`,
        [db.projectId],
      ),
    );
    expect(names.map((n) => n.raw_name)).toEqual(['Page Viewed']);
  });

  it('raises the totals when a page leave is re-sent, rather than dropping it', async () => {
    const { project, publishableKey } = await newFixture();
    const leave = (activeSeconds: number) => ({
      type: 'page',
      name: 'Page Left',
      // Deterministic per page view, so the server updates instead of deduping.
      messageId: 'pl-same',
      anonymousId: 'anon-3',
      properties: { path: '/pricing', activeSeconds, pageViewId: 'pv-same' },
      context: { page: { path: '/pricing' }, sessionId: 's-3' },
    });

    await postBatch([leave(10)], { key: publishableKey, userAgent: BROWSER_UA });
    await postBatch([leave(95)], { key: publishableKey, userAgent: BROWSER_UA });

    const rows = await withProject(project.live.id, (db) =>
      db.query<{ count: string; active: string | null }>(
        `SELECT count(*)::text AS count, max(e.props->>'activeSeconds') AS active
           FROM events e
           JOIN event_names n ON n.project_id = e.project_id AND n.id = e.name_id
          WHERE e.project_id = $1 AND n.raw_name = 'Page Left'`,
        [db.projectId],
      ),
    );

    expect(rows[0]!.count).toBe('1');
    expect(rows[0]!.active).toBe('95');
  });
});

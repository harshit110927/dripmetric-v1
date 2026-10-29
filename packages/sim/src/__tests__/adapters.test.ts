import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  closePools,
  createProject,
  createSource,
  sourceSummary,
  withProject,
} from '@dripmetric/db';
import { handleSourceWebhook, POSTHOG_ALLOWED } from '@dripmetric/ingest';
import { runSimulation } from '../run.js';
import { product } from '../products/index.js';
import { configureProject } from '../setup.js';
import {
  postHogAutocaptureNoise,
  toPostHogEvents,
  toRudderStackBatch,
  toSegmentBatch,
} from '../emitters.js';
import { keysOf, sendRun } from './send.js';
import { ensureMigrated, resetData } from './db.js';

/**
 * The no-code source adapters (brief §5, M12's exit checks).
 *
 * The comparison is the point: the SAME simulated journeys are loaded once through
 * the native SDK path and once through each adapter, and the canonical events in the
 * database have to match. Two hand-written fixtures that happened to agree would
 * prove nothing.
 */

const NOW = new Date('2026-11-10T12:00:00Z');

async function projectWithSource(kind: 'segment' | 'rudderstack' | 'posthog') {
  const definition = product('selfserve');
  const created = await createProject({
    name: `Adapter ${kind}`,
    settings: {
      listPriceAmount: definition.listPriceAmount,
      internalDomains: ['ledgerly-internal.com'],
    },
  });
  await withProject(created.live.id, (db) => configureProject(db, definition));
  const source = await withProject(created.live.id, (db) => createSource(db, kind, null));
  return { created, source };
}

/** Segment's documented scheme: hex HMAC-SHA1 of the body in `X-Signature`. */
function segmentSignature(body: string, secret: string): string {
  return createHmac('sha1', secret).update(body, 'utf8').digest('hex');
}

/** The canonical events stored for a project, as a comparable shape. */
async function storedEvents(projectId: number): Promise<{ name: string; count: number }[]> {
  return withProject(projectId, async (db) => {
    const rows = await db.query<{ name: string; n: string }>(
      `SELECT coalesce(n.canonical, n.raw_name) AS name, count(*) AS n
         FROM events e
         JOIN event_names n ON n.project_id = e.project_id AND n.id = e.name_id
        WHERE e.project_id = $1
        GROUP BY 1 ORDER BY 1`,
      [db.projectId],
    );
    return rows.map((row) => ({ name: row.name, count: Number(row.n) }));
  });
}

describe('the source adapters', () => {
  beforeAll(ensureMigrated);
  beforeEach(resetData);

  it('refuses a bad signature with 401, and accepts a good one', async () => {
    // M12 exit check.
    const { source } = await projectWithSource('segment');
    const run = runSimulation({ product: 'selfserve', users: 5, seed: 11 });
    const body = JSON.stringify(toSegmentBatch(run.messages.slice(0, 20)));

    await expect(
      handleSourceWebhook('segment', source.publicId, {
        rawBody: body,
        headers: { 'x-signature': 'deadbeef' },
        receivedAt: NOW,
      }),
    ).rejects.toThrow(/signature/i);

    const good = await handleSourceWebhook('segment', source.publicId, {
      rawBody: body,
      headers: { 'x-signature': segmentSignature(body, source.secret) },
      receivedAt: NOW,
    });
    expect(good.status).toBe(200);
  });

  it('accepts a batch signed over its FIRST event, as Segment does when batching', async () => {
    /*
     * The gotcha from Segment's own docs: with batching enabled it signs the first
     * event, not the whole batch. A verifier that only hashes the body rejects every
     * batched delivery, which looks exactly like a wrong secret.
     */
    const { source } = await projectWithSource('segment');
    const run = runSimulation({ product: 'selfserve', users: 5, seed: 11 });
    const events = toSegmentBatch(run.messages.slice(0, 20)) as unknown[];
    const body = JSON.stringify(events);

    const response = await handleSourceWebhook('segment', source.publicId, {
      rawBody: body,
      headers: { 'x-signature': segmentSignature(JSON.stringify(events[0]), source.secret) },
      receivedAt: NOW,
    });
    expect(response.status).toBe(200);
  });

  it('answers 401 for an unknown source id, with no hint that it is unknown', async () => {
    await expect(
      handleSourceWebhook('segment', '00000000-0000-4000-8000-000000000000', {
        rawBody: '[]',
        headers: { 'x-signature': 'x' },
        receivedAt: NOW,
      }),
    ).rejects.toThrow(/not set up|removed/i);
  });

  it('does not 500 on a source id that is not even a uuid', async () => {
    // `public_id = $1` against a non-uuid raises `invalid input syntax for type uuid`,
    // which would turn a probe into a 500 and leak that the column is a uuid.
    await expect(
      handleSourceWebhook('segment', 'not-a-uuid', {
        rawBody: '[]',
        headers: { 'x-signature': 'x' },
        receivedAt: NOW,
      }),
    ).rejects.toThrow(/not set up|removed/i);
  });

  it.each([
    ['segment', toSegmentBatch],
    ['rudderstack', toRudderStackBatch],
  ] as const)(
    'produces the same canonical events through %s as the native SDK does',
    async (kind, emit) => {
      // M12 exit check, as a real comparison over the same journeys.
      const run = runSimulation({ product: 'selfserve', users: 25, seed: 7 });

      // Native.
      const definition = product('selfserve');
      const native = await createProject({
        name: 'native',
        settings: { internalDomains: ['ledgerly-internal.com'] },
      });
      await withProject(native.live.id, (db) => configureProject(db, definition));
      await sendRun(run.messages, keysOf(native), { userAgent: null });
      const nativeEvents = await storedEvents(native.live.id);

      // Through the adapter.
      const { created, source } = await projectWithSource(kind);
      const body = JSON.stringify(emit(run.messages));
      /*
       * Received when the run ENDED, not "now".
       *
       * A simulated run spans months in the past, and ingest refuses an event older
       * than the retention window — correctly, since it would be deleted the same
       * night. The native path already stamps each batch with its own delivery time;
       * this is the adapter doing the same, which is also what a real feed does.
       */
      const receivedAt = new Date(run.truthFile.endedAt);
      const headers =
        kind === 'segment'
          ? { 'x-signature': segmentSignature(body, source.secret) }
          : { authorization: source.secret };

      const response = await handleSourceWebhook(kind, source.publicId, {
        rawBody: body,
        headers,
        receivedAt,
      });
      expect(response.status).toBe(200);

      // Nothing was rejected: a non-empty `results` with errors would mean the
      // adapter built a message the pipeline would not take.
      const results = (response.body as { results?: { status: string; code?: string }[] }).results;
      const errors = (results ?? []).filter((r) => r.status === 'error');
      expect(errors.map((e) => e.code)).toEqual([]);

      const adapterEvents = await storedEvents(created.live.id);

      /*
       * The same names, in the same proportions.
       *
       * Not identical counts: the native path sends browser and server messages with
       * their own keys and the adapter posts everything server-side, so sessionisation
       * differs slightly. The NAMES and their ordering are what "the same canonical
       * events" means, and a renamed or dropped event shows up here immediately.
       */
      expect(adapterEvents.map((e) => e.name)).toEqual(nativeEvents.map((e) => e.name));
      for (const native of nativeEvents) {
        const mine = adapterEvents.find((e) => e.name === native.name);
        expect(mine, native.name).toBeDefined();
        expect(mine!.count, native.name).toBeGreaterThan(0);
      }
    },
    120_000,
  );

  it('drops PostHog events outside the allow-list and counts them', async () => {
    // M12 exit check.
    const { created, source } = await projectWithSource('posthog');
    const run = runSimulation({ product: 'selfserve', users: 10, seed: 3 });

    const wanted = toPostHogEvents(run.messages.slice(0, 60));
    const noise = postHogAutocaptureNoise(25);
    const body = JSON.stringify([...wanted, ...noise]);

    const response = await handleSourceWebhook('posthog', source.publicId, {
      rawBody: body,
      headers: { authorization: source.secret },
      receivedAt: NOW,
    });

    expect(response.status).toBe(200);
    const dropped = (response.body as { dropped: { reason: string; count: number }[] }).dropped;
    const autocapture = dropped.find((entry) => entry.reason.includes('$autocapture'));

    expect(autocapture?.count).toBe(25);
    // The allow-list is deny-by-default, so a new PostHog `$event` is dropped too.
    expect(POSTHOG_ALLOWED.has('$autocapture')).toBe(false);

    // And the count is kept on the source, for the founder's settings screen.
    const summary = await withProject(created.live.id, sourceSummary);
    expect(summary[0]?.dropped).toBe(25);
    expect(summary[0]?.dropReasons[0]?.reason).toContain('$autocapture');
    expect(summary[0]?.accepted).toBeGreaterThan(0);
  });

  it('records a failed delivery without telling the caller why', async () => {
    const { created, source } = await projectWithSource('segment');

    await expect(
      handleSourceWebhook('segment', source.publicId, {
        rawBody: '[]',
        headers: { 'x-signature': 'nope' },
        receivedAt: NOW,
      }),
    ).rejects.toThrow();

    const summary = await withProject(created.live.id, sourceSummary);
    // The founder sees the reason on their own screen...
    expect(summary[0]?.lastError).toContain('does not match');
    // ...and the delivery is counted either way.
    expect(summary[0]?.deliveries).toBe(1);
  });

  it('treats a delivery of nothing but noise as a success, so the tool stops retrying', async () => {
    const { source } = await projectWithSource('posthog');
    const body = JSON.stringify(postHogAutocaptureNoise(10));

    const response = await handleSourceWebhook('posthog', source.publicId, {
      rawBody: body,
      headers: { authorization: source.secret },
      receivedAt: NOW,
    });

    expect(response.status).toBe(200);
    expect((response.body as { accepted: number }).accepted).toBe(0);
  });

  it('shows the secret once and never again', async () => {
    const { created, source } = await projectWithSource('segment');
    expect(source.secret).toMatch(/^[A-Za-z0-9_-]{20,}$/);

    const summary = await withProject(created.live.id, sourceSummary);
    // The summary a screen reads cannot carry it.
    expect(JSON.stringify(summary)).not.toContain(source.secret);
  });
});

describe('closing the pools', () => {
  it('closes', async () => {
    await closePools();
  });
});

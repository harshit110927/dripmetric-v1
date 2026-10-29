import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  checkSignupAllowed,
  closePools,
  createProject,
  createSource,
  firstEventState,
  recordSignupAttempt,
  startFreeAudit,
  withProject,
  withoutProject,
} from '@dripmetric/db';
import { checkTrackingHealth, handleBatch, handleSourceWebhook } from '@dripmetric/ingest';
import {
  SNIPPET_STACKS,
  generateSnippet,
  librariesFor,
  type SnippetStep,
} from '@dripmetric/engine';
import { runSimulation } from '../run.js';
import { product } from '../products/index.js';
import { configureProject } from '../setup.js';
import { toSegmentBatch } from '../emitters.js';
import { keysOf } from './send.js';
import { ensureMigrated, resetData } from './db.js';

/**
 * The AI-coder prompt generator, the double-path warning and the free audit
 * (brief §9, M12's remaining exit checks).
 */

const NOW = new Date('2026-11-10T12:00:00Z');

const STEPS: SnippetStep[] = [
  { label: 'Sign up', eventName: 'Signed Up', position: 1 },
  { label: 'Connect a data source', eventName: 'Integration Connected', position: 2 },
  { label: 'See your first report', eventName: 'Core Action Done', position: 3 },
];

function snippetInput(
  stack: (typeof SNIPPET_STACKS)[number],
  library: 'dripmetric' | 'segment' | 'http',
) {
  return {
    stack,
    library,
    host: 'http://localhost:3000',
    publishableKey: 'pk_live_example',
    secretKeyPlaceholder: 'YOUR_SECRET_KEY',
    steps: STEPS,
    paidEvent: 'Subscription Started',
  };
}

describe('the AI-coder prompt generator', () => {
  it('offers only libraries that exist for each stack', () => {
    // A Segment Go library does not exist; generating one would produce a snippet
    // that cannot run, and a founder debugging it has no way to know whose bug it is.
    expect(librariesFor('go-net-http')).toEqual(['http']);
    expect(librariesFor('next-app-router')).toContain('dripmetric');
    expect(librariesFor('python-django')).not.toContain('dripmetric');
  });

  it('falls back to plain HTTP rather than inventing a library, and says so', () => {
    const result = generateSnippet(snippetInput('go-net-http', 'dripmetric'));
    expect(result.library).toBe('http');
    expect(result.notes.join(' ')).toContain('no dripmetric library for this stack');
  });

  it('uses the project’s own step labels and canonical names', () => {
    // Brief §9: "shows the exact places to call them, and follows the project's
    // funnel config".
    const result = generateSnippet(snippetInput('node-express', 'dripmetric'));
    expect(result.code).toContain('Step 2: Connect a data source -> "Integration Connected"');
    expect(result.prompt).toContain('"Connect a data source" is complete when you send');
    expect(result.prompt).toContain('Integration Connected');
  });

  it('always sets the host for Segment’s libraries, and says why', () => {
    // The one mistake that silently sends a founder's events to Segment instead.
    for (const stack of ['python-django', 'ruby-rails', 'php-laravel'] as const) {
      const result = generateSnippet(snippetInput(stack, 'segment'));
      expect(result.code, stack).toContain('localhost:3000');
      expect(result.notes.join(' '), stack).toContain('without the host your events go there');
    }
  });

  it('tells a PHP founder which consumer to use', () => {
    // Segment's PHP library blocks the request on its default consumer.
    const result = generateSnippet(snippetInput('php-laravel', 'segment'));
    expect(result.code).toContain("'consumer' => 'fork_curl'");
    expect(result.notes.join(' ')).toContain('file');
  });

  it('never prints a secret key, in any stack or library', () => {
    for (const stack of SNIPPET_STACKS) {
      for (const library of librariesFor(stack)) {
        const result = generateSnippet(snippetInput(stack, library));
        const text = `${result.code}\n${result.prompt}`;
        // A real secret token would start `sk_live_`; the generator must only ever
        // emit a placeholder or an environment variable.
        expect(text, `${stack}/${library}`).not.toMatch(/sk_live_[A-Za-z0-9]/);
        if (text.includes('SECRET')) {
          expect(text, `${stack}/${library}`).toMatch(
            /env|ENV|getenv|process\.env|YOUR_SECRET_KEY/,
          );
        }
      }
    }
  });

  it('warns the AI agent not to put the secret in browser code', () => {
    const result = generateSnippet(snippetInput('next-app-router', 'dripmetric'));
    expect(result.prompt).toContain('server-side only');
    expect(result.prompt).toContain('Never import it into browser code');
  });
});

describe('the generated samples against local ingest', () => {
  beforeAll(ensureMigrated);
  beforeEach(resetData);

  /**
   * M12 exit check: "generated samples for Node, Python (via Segment's library) and
   * plain HTTP run against local ingest".
   *
   * The plain-HTTP sample is EXECUTED: its JSON body is lifted out of the generated
   * curl and posted through the same handler the route calls, so "it runs" is a fact
   * rather than a claim. The library samples cannot be executed from here without
   * installing three language runtimes, so what is checked is the part that would
   * actually break — that the names they send are canonical and the host is ours.
   */
  it('runs the plain-HTTP sample against ingest and stores the events', async () => {
    const definition = product('selfserve');
    const created = await createProject({ name: 'snippet', settings: {} });
    await withProject(created.live.id, (db) => configureProject(db, definition));
    const keys = keysOf(created);

    const result = generateSnippet({
      ...snippetInput('plain-http', 'http'),
      secretKeyPlaceholder: keys.secret,
    });

    // Lift the JSON body out of the generated curl: between the first `{` after
    // -d ' and the closing '.
    const match = /-d '([\s\S]+)'$/.exec(result.code.trim());
    expect(match).not.toBeNull();
    const body = match![1]!;

    const response = await handleBatch({
      body,
      headers: { authorization: `Bearer ${keys.secret}`, 'content-type': 'application/json' },
      receivedAt: NOW,
    });

    expect(response.status).toBe(200);
    const results = (response.body as { results: { status: string; code?: string }[] }).results;
    expect(results.filter((r) => r.status === 'error').map((r) => r.code)).toEqual([]);
    expect(results.length).toBeGreaterThan(1);

    const stored = await withProject(created.live.id, (db) =>
      db.query<{ name: string }>(
        `SELECT coalesce(n.canonical, n.raw_name) AS name
           FROM events e JOIN event_names n ON n.project_id = e.project_id AND n.id = e.name_id
          WHERE e.project_id = $1 ORDER BY 1`,
        [db.projectId],
      ),
    );
    expect(stored.map((row) => row.name)).toContain('Signed Up');
  });

  it('emits canonical names and our host in the Node and Python samples', async () => {
    const definition = product('selfserve');
    const created = await createProject({ name: 'snippet2', settings: {} });
    await withProject(created.live.id, (db) => configureProject(db, definition));

    for (const [stack, library] of [
      ['node-express', 'dripmetric'],
      ['python-django', 'segment'],
    ] as const) {
      const result = generateSnippet(snippetInput(stack, library));

      // The names it sends are the project's own canonical ones.
      expect(result.code, stack).toContain('Signed Up');
      // Pointed at us, not at Segment.
      expect(result.code, stack).toContain('localhost:3000');
      // And the install line is the real package for that language.
      expect(result.install, stack).toBeTruthy();
    }
  });
});

describe('the double-path warning', () => {
  beforeAll(ensureMigrated);
  beforeEach(resetData);

  it('appears when the same event arrives from the SDK and a no-code feed', async () => {
    // M12 exit check. This is the real scenario: a founder wires Segment, then adds
    // our SDK, and both send Signed Up.
    const definition = product('selfserve');
    const created = await createProject({ name: 'both paths', settings: {} });
    await withProject(created.live.id, (db) => configureProject(db, definition));
    const keys = keysOf(created);
    const source = await withProject(created.live.id, (db) => createSource(db, 'segment', null));

    const run = runSimulation({ product: 'selfserve', users: 8, seed: 21 });
    const receivedAt = new Date(run.truthFile.endedAt);

    /*
     * Server-sent messages only, re-stamped into the last few hours.
     *
     * The duplicate check looks at a 24-hour window, which is right in production —
     * a founder wants to know about duplicates happening NOW, not a pair from six
     * weeks ago. A simulated run spans weeks, so without re-stamping almost nothing
     * falls inside the window and the check correctly finds nothing.
     */
    const shared = run.messages
      .filter((m) => m.serverSide)
      .slice(0, 40)
      .map((m, i) => ({
        ...m,
        message: {
          ...m.message,
          timestamp: new Date(receivedAt.getTime() - (i + 1) * 60_000).toISOString(),
        },
      }));

    // Path one: our own SDK.
    await handleBatch({
      body: JSON.stringify({ batch: shared.map((m) => m.message) }),
      headers: { authorization: `Bearer ${keys.secret}`, 'content-type': 'application/json' },
      receivedAt,
    });

    /*
     * Path two: the same ACTIONS through Segment, with its own message ids.
     *
     * The ids have to differ, and finding that out was the point. Reusing them made
     * this test fail, because dedupe by `messageId` works across source paths — the
     * second copy was correctly ignored and there was nothing to warn about. That is
     * right for a retry and wrong as a model of this problem: two independent
     * integrations each generate their own ids, so the duplicate is invisible to
     * dedupe and only the same-person-same-second-two-sources check can see it.
     */
    const reIdentified = shared.map((message, i) => ({
      ...message,
      message: { ...message.message, messageId: `segment_own_${i}` },
    }));
    const body = JSON.stringify(toSegmentBatch(reIdentified));
    await handleSourceWebhook('segment', source.publicId, {
      rawBody: body,
      headers: { 'x-signature': createHmac('sha1', source.secret).update(body).digest('hex') },
      receivedAt,
    });

    const health = await withProject(created.live.id, (db) => checkTrackingHealth(db, receivedAt));
    const warning = health.findings.find((finding) => finding.kind === 'double-sent');

    expect(warning).toBeDefined();
    expect(warning?.says).toContain('arriving from 2 places at once');
    expect(warning?.says).toContain('segment');
    expect(warning?.fix).toContain('Send it from one place');
  });
});

describe('the free audit guards', () => {
  beforeAll(ensureMigrated);
  beforeEach(resetData);

  it('refuses a throwaway address with something the person can act on', async () => {
    const result = await withoutProject('resolve-api-key', (db) =>
      checkSignupAllowed(db, 'someone@mailinator.com', '203.0.113.7', NOW),
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('disposable-email');
    expect(result.because).toContain('the email you actually read');
  });

  it('allows a free provider, because plenty of founders use one', async () => {
    const result = await withoutProject('resolve-api-key', (db) =>
      checkSignupAllowed(db, 'founder@gmail.com', '203.0.113.7', NOW),
    );
    expect(result.allowed).toBe(true);
  });

  it('refuses a malformed address before anything else', async () => {
    for (const bad of ['no-at-sign', 'two@@at.com', 'spaces in@example.com', 'a@b']) {
      const result = await withoutProject('resolve-api-key', (db) =>
        checkSignupAllowed(db, bad, null, NOW),
      );
      expect(result.allowed, bad).toBe(false);
      expect(result.reason, bad).toBe('bad-email');
    }
  });

  it('limits how many projects one network can make in a day', async () => {
    const ip = '203.0.113.9';
    await withoutProject('resolve-api-key', async (db) => {
      for (let i = 0; i < 5; i++) {
        await recordSignupAttempt(
          db,
          { email: `f${i}@example.com`, ip, createdProject: true, reason: 'ok' },
          NOW,
        );
      }
    });

    const blocked = await withoutProject('resolve-api-key', (db) =>
      checkSignupAllowed(db, 'another@example.com', ip, NOW),
    );
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toBe('ip-limit');

    // A different network is unaffected.
    const other = await withoutProject('resolve-api-key', (db) =>
      checkSignupAllowed(db, 'another@example.com', '198.51.100.4', NOW),
    );
    expect(other.allowed).toBe(true);
  });

  it('stores the IP hashed and only the email domain', async () => {
    const ip = '203.0.113.55';
    await withoutProject('resolve-api-key', (db) =>
      recordSignupAttempt(
        db,
        { email: 'Jo.Bloggs@Acme.test', ip, createdProject: true, reason: 'ok' },
        NOW,
      ),
    );

    const row = await withoutProject('resolve-api-key', (db) =>
      db.one<{ ip_hash: Buffer; email_domain: string }>(
        `SELECT ip_hash, email_domain FROM signup_attempts ORDER BY id DESC LIMIT 1`,
      ),
    );

    // The address itself is not kept: these people are not customers.
    expect(row.email_domain).toBe('acme.test');
    expect(row.ip_hash.toString('utf8')).not.toContain(ip);
    expect(row.ip_hash.length).toBe(32);
  });

  it('lets the signup through when there is no IP to read', async () => {
    // Behind some proxies there is no forwarded address, and refusing everyone in
    // that situation would make the product unusable for them.
    const result = await withoutProject('resolve-api-key', (db) =>
      checkSignupAllowed(db, 'founder@acme.test', null, NOW),
    );
    expect(result.allowed).toBe(true);
  });
});

describe('the free audit, end to end', () => {
  beforeAll(ensureMigrated);
  beforeEach(resetData);

  /**
   * M12 exit check: "the free-audit flow works end to end locally (email, keys,
   * first event, dashboard)".
   *
   * Each step feeds the next, so a break anywhere in the chain fails here rather
   * than being caught by a screenshot later.
   */
  it('goes from an email to a real number', async () => {
    // 1. Email in.
    const started = await startFreeAudit({ email: 'Jo@Acme.test', ip: '203.0.113.20' }, NOW);
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    // The project is named after their domain, which is usually right.
    expect(started.project.live.name).toBe('Acme');
    // Unclaimed, so M11's sweep will clean it up if they walk away.
    expect(started.project.live.claimedAt).toBeNull();

    // 2. Keys out — both kinds, and the secret readable exactly once.
    const keys = keysOf(started.project);
    expect(keys.publishable).toMatch(/^pk_live_/);
    expect(keys.secret).toMatch(/^sk_live_/);

    // 3. Nothing yet, so the setup screen keeps waiting.
    const before = await firstEventState(started.project.live.id, NOW);
    expect(before.arrived).toBe(false);
    expect(before.events).toBe(0);

    // 4. The first event, through the real API with the real key.
    const response = await handleBatch({
      body: JSON.stringify({
        batch: [
          {
            type: 'track',
            messageId: 'first-event-1',
            userId: 'user_1',
            event: 'Signed Up',
            timestamp: NOW.toISOString(),
          },
        ],
      }),
      headers: { authorization: `Bearer ${keys.secret}`, 'content-type': 'application/json' },
      receivedAt: NOW,
    });
    expect(response.status).toBe(200);

    // 5. The screen flips, and can say what it can see.
    const after = await firstEventState(started.project.live.id, NOW);
    expect(after.arrived).toBe(true);
    expect(after.events).toBe(1);
    expect(after.names).toContain('Signed Up');

    // 6. And the dashboard has a real number in it.
    const intent = await withProject(started.project.live.id, (db) =>
      db.one<{ n: string }>(`SELECT count(*) AS n FROM end_users WHERE project_id = $1`, [
        db.projectId,
      ]),
    );
    expect(Number(intent.n)).toBe(1);
  });

  it('refuses a throwaway address before making anything', async () => {
    const result = await startFreeAudit({ email: 'nope@mailinator.com', ip: '203.0.113.21' }, NOW);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('disposable-email');

    // Nothing was created, and the attempt was still recorded so the count is honest.
    const projects = await withoutProject('worker-sweep', (db) =>
      db.one<{ n: string }>(`SELECT count(*) AS n FROM projects`),
    );
    expect(Number(projects.n)).toBe(0);
    const attempts = await withoutProject('worker-sweep', (db) =>
      db.one<{ n: string }>(`SELECT count(*) AS n FROM signup_attempts`),
    );
    expect(Number(attempts.n)).toBe(1);
  });

  it('reuses the founder row when the same person starts twice', async () => {
    const first = await startFreeAudit({ email: 'jo@acme.test', ip: null }, NOW);
    const second = await startFreeAudit({ email: 'JO@ACME.TEST', ip: null }, NOW);

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    // One person, two projects — not two accounts with the same address.
    expect(second.founderUserId).toBe(first.founderUserId);
    expect(second.project.live.id).not.toBe(first.project.live.id);
  });
});

describe('closing the pools', () => {
  it('closes', async () => {
    await closePools();
  });
});

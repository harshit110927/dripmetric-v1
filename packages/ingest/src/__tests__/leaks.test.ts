import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closePools, withProject } from '@dripmetric/db';
import { isTrialCheckout } from '../leaks/facts.js';
import { recordFindings, resolveLeaks, sweepUserLeaks } from '../leaks/sweeps.js';
import { ensureMigrated, newFixture, postBatch, resetData, track } from './helpers.js';
import type { LeakFinding } from '@dripmetric/engine';

/**
 * M8 exit check (brief §11): "each fires exactly once per episode; a returning user
 * resets it."
 *
 * The engine fixtures prove the rules produce one finding per episode. These prove
 * the GUARANTEE: the unique index on `leak_instances`, which is what stops a founder
 * getting the same alert every five minutes when the rule keeps returning it.
 */

const NOW = new Date('2026-10-29T12:00:00Z');

function finding(overrides: Partial<LeakFinding> = {}): LeakFinding {
  return {
    type: 'last-moment-drop',
    subject: 'user',
    subjectKey: 1,
    firedAt: NOW,
    episodeKey: 'checkout:2026-10-29T09:00:00.000Z',
    says: 'They started checking out and no payment arrived.',
    details: { waitedHours: 2 },
    ...overrides,
  };
}

/** A user row to hang leaks off, since `leak_instances` has no FK to one. */
async function aUser(projectId: number, externalId = 'u1'): Promise<number> {
  return withProject(projectId, async (db) => {
    const row = await db.one<{ user_key: number }>(
      `INSERT INTO end_users (project_id, external_id, first_seen_at, last_event_at)
       VALUES ($1, $2, now(), now())
       ON CONFLICT (project_id, external_id) DO UPDATE SET last_event_at = now()
       RETURNING user_key`,
      [db.projectId, externalId],
    );
    return row.user_key;
  });
}

describe('one alert per person per leak', () => {
  beforeAll(ensureMigrated, 60_000);
  beforeEach(resetData);
  afterAll(closePools);

  it('records an episode once, however many times the sweep finds it', async () => {
    const { project } = await newFixture();
    const userKey = await aUser(project.live.id);
    const same = finding({ subjectKey: userKey });

    const first = await withProject(project.live.id, (db) => recordFindings(db, [same]));
    const second = await withProject(project.live.id, (db) => recordFindings(db, [same]));
    const third = await withProject(project.live.id, (db) => recordFindings(db, [same, same]));

    expect(first).toBe(1);
    // The rule keeps returning it, and it keeps not being recorded again.
    expect(second).toBe(0);
    expect(third).toBe(0);

    const rows = await withProject(project.live.id, (db) =>
      db.query<{ count: string; episode: number }>(
        `SELECT count(*)::text AS count, max(episode) AS episode
           FROM leak_instances WHERE project_id = $1`,
        [db.projectId],
      ),
    );
    expect(rows[0]!.count).toBe('1');
    expect(rows[0]!.episode).toBe(1);
  });

  it('lets a new episode fire, and numbers it', async () => {
    const { project } = await newFixture();
    const userKey = await aUser(project.live.id);

    await withProject(project.live.id, (db) =>
      recordFindings(db, [finding({ subjectKey: userKey, episodeKey: 'checkout:one' })]),
    );
    const second = await withProject(project.live.id, (db) =>
      recordFindings(db, [finding({ subjectKey: userKey, episodeKey: 'checkout:two' })]),
    );

    expect(second).toBe(1);
    const rows = await withProject(project.live.id, (db) =>
      db.query<{ episode: number; episode_key: string }>(
        `SELECT episode, episode_key FROM leak_instances
          WHERE project_id = $1 ORDER BY episode`,
        [db.projectId],
      ),
    );
    expect(rows.map((r) => r.episode)).toEqual([1, 2]);
  });

  it('keeps different leaks and different people apart', async () => {
    const { project } = await newFixture();
    const one = await aUser(project.live.id, 'u1');
    const two = await aUser(project.live.id, 'u2');

    const recorded = await withProject(project.live.id, (db) =>
      recordFindings(db, [
        finding({ subjectKey: one }),
        finding({ subjectKey: two }),
        finding({ subjectKey: one, type: 'high-intent-quiet', episodeKey: 'quiet:x' }),
        finding({ subjectKey: 3, type: 'step-collapse', subject: 'step', episodeKey: 'c:1' }),
      ]),
    );
    expect(recorded).toBe(4);
  });

  it('cannot leak an episode into another project', async () => {
    const a = await newFixture('A');
    const b = await newFixture('B');
    const userA = await aUser(a.project.live.id);
    const userB = await aUser(b.project.live.id);

    await withProject(a.project.live.id, (db) =>
      recordFindings(db, [finding({ subjectKey: userA })]),
    );
    const inB = await withProject(b.project.live.id, (db) =>
      recordFindings(db, [finding({ subjectKey: userB })]),
    );

    // The same leak, the same episode key, a different project: a separate row.
    expect(inB).toBe(1);
    const counts = await withProject(b.project.live.id, (db) =>
      db.query<{ count: string }>(`SELECT count(*)::text AS count FROM leak_instances`),
    );
    // And the scoped read sees only its own.
    expect(counts[0]!.count).toBe('1');
  });

  it('resolves a stall when the person comes back', async () => {
    const { project } = await newFixture();
    const userKey = await aUser(project.live.id);

    await withProject(project.live.id, (db) =>
      recordFindings(db, [
        finding({
          subjectKey: userKey,
          type: 'onboarding-stall',
          episodeKey: 'step:2:x',
          firedAt: new Date(NOW.getTime() - 86_400_000),
        }),
      ]),
    );

    const resolved = await withProject(project.live.id, async (db) => {
      // `aUser` set last_event_at to now, which is after the leak fired.
      return resolveLeaks(db, NOW);
    });

    expect(resolved).toBe(1);
    const row = await withProject(project.live.id, (db) =>
      db.one<{ state: string; resolved_at: Date | null }>(
        `SELECT state, resolved_at FROM leak_instances WHERE project_id = $1`,
        [db.projectId],
      ),
    );
    // The row stays: the episode happened.
    expect(row.state).toBe('resolved');
    expect(row.resolved_at).toEqual(NOW);
  });
});

describe('a trial-only checkout', () => {
  /*
   * Brief §8.3: "Trial-only checkouts are marked by `type: "trial"` on
   * `Checkout Started` (default `purchase`; accept `trial: true` as an alias). They
   * add no intent points and never count as a last-moment drop."
   *
   * Getting this wrong would alert a founder about every trial signup as a lost sale,
   * which is the fastest way to teach them to ignore the product.
   */
  beforeAll(ensureMigrated, 60_000);
  beforeEach(resetData);
  afterAll(closePools);

  it('recognises both spellings, and the purchase default', () => {
    expect(isTrialCheckout({ type: 'trial' })).toBe(true);
    expect(isTrialCheckout({ type: 'TRIAL' })).toBe(true);
    expect(isTrialCheckout({ trial: true })).toBe(true);
    expect(isTrialCheckout({ trial: 'true' })).toBe(true);
    expect(isTrialCheckout({ type: 'purchase' })).toBe(false);
    expect(isTrialCheckout({})).toBe(false);
    expect(isTrialCheckout(null)).toBe(false);
  });

  it('never becomes a last-moment drop', async () => {
    const { project, secretKey } = await newFixture();
    const threeHoursAgo = new Date(Date.now() - 3 * 3_600_000).toISOString();

    await postBatch(
      [
        track('Signed Up', { userId: 'trial-user', timestamp: threeHoursAgo }),
        track('Checkout Started', {
          userId: 'trial-user',
          timestamp: threeHoursAgo,
          properties: { plan: 'pro', amount: 1900, currency: 'usd', type: 'trial' },
        }),
        track('Signed Up', { userId: 'real-user', timestamp: threeHoursAgo }),
        track('Checkout Started', {
          userId: 'real-user',
          timestamp: threeHoursAgo,
          properties: { plan: 'pro', amount: 1900, currency: 'usd' },
        }),
        // A paid event exists, so the leak is not switched off for want of one.
        track('Subscription Started', {
          userId: 'someone-else',
          timestamp: threeHoursAgo,
          properties: { plan: 'pro', amount: 1900, currency: 'usd', interval: 'month' },
        }),
      ],
      { key: secretKey },
    );

    const result = await withProject(project.live.id, (db) => sweepUserLeaks(db, new Date()));
    // The paid event exists, so this leak can run. Nobody in this fixture has a
    // trial, so trial-ended-unpaid is correctly off — which is its own test below.
    expect(result.off.map((entry) => entry.type)).toEqual(['trial-ended-unpaid']);

    const drops = await withProject(project.live.id, (db) =>
      db.query<{ external_id: string }>(
        `SELECT u.external_id
           FROM leak_instances l
           JOIN end_users u ON u.project_id = l.project_id AND u.user_key = l.subject_key
          WHERE l.project_id = $1 AND l.leak_type = 'last-moment-drop'`,
        [db.projectId],
      ),
    );

    expect(drops.map((d) => d.external_id)).toEqual(['real-user']);
  });

  it('switches the paid-event leaks off, with a reason, when no payment ever arrives', async () => {
    const { project, secretKey } = await newFixture();
    await postBatch([track('Signed Up', { userId: 'u1' })], { key: secretKey });

    const result = await withProject(project.live.id, (db) => sweepUserLeaks(db, new Date()));

    const off = result.off.map((entry) => entry.type).sort();
    expect(off).toContain('last-moment-drop');
    expect(off).toContain('high-intent-quiet');
    expect(off).toContain('trial-ended-unpaid');
    expect(off).toContain('payer-going-quiet');
    expect(off).toContain('limit-reached-no-upgrade');
    for (const entry of result.off) {
      expect(entry.because.length).toBeGreaterThan(30);
    }
    // And nothing those leaks would have found was recorded.
    expect(result.byType['last-moment-drop']).toBeUndefined();
  });
});

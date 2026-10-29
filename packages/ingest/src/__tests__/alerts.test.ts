import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  alertFeed,
  closePools,
  createProject,
  markFeedRead,
  saveIntegration,
  unreadAlertCount,
  withProject,
  type ScopedDb,
} from '@dripmetric/db';
import { DEFAULT_ALERTS_PER_DAY } from '@dripmetric/engine';
import { decideProjectAlerts, deliverDueAlerts, type PostWebhook } from '../alerts/dispatch.js';
import { ensureMigrated, resetData } from './helpers.js';

/**
 * The alert pipeline against a real database (brief §9, M10's exit checks).
 *
 * The engine tests prove the policy over fixtures; this proves the SQL, the feed and
 * the delivery log — and it is where "the 11th alert in a day goes only to the feed"
 * and "an alert in quiet hours is held until morning" are actually demonstrated end
 * to end rather than argued about.
 *
 * Nothing here reaches Slack or Discord: the poster is injected (CLAUDE.md rule 3).
 */

/** 14:00 in Berlin on a Tuesday: awake, well inside working hours. */
const AWAKE = new Date('2026-11-10T13:00:00Z');
/** 23:30 in Berlin the same day: inside quiet hours. */
const ASLEEP = new Date('2026-11-10T22:30:00Z');

interface Recorder {
  post: PostWebhook;
  calls: { url: string; body: unknown }[];
  reply: { ok: boolean; status: number; detail: string };
}

function recorder(reply = { ok: true, status: 200, detail: 'ok' }): Recorder {
  const self: Recorder = {
    calls: [],
    reply,
    post: (url, body) => {
      self.calls.push({ url, body });
      return Promise.resolve(self.reply);
    },
  };
  return self;
}

async function makeProject(settings: Record<string, unknown> = {}) {
  const created = await createProject({
    name: 'Alerts',
    timezone: 'Europe/Berlin',
    settings: {
      alertChannel: 'slack',
      listPriceAmount: 4_900,
      listPriceCurrency: 'usd',
      ...settings,
    },
  });
  await withProject(created.live.id, (db) =>
    saveIntegration(
      db,
      {
        kind: 'slack',
        // A shaped but fake URL: nothing is ever posted to it.
        webhookUrl: 'https://hooks.slack.test/services/T000/B000/xxxxxxxx',
        channelLabel: '#leaks',
        workspaceLabel: 'Acme',
      },
      null,
    ),
  );
  return created.live.id;
}

/** A person, and a `last-moment-drop` leak about them that has not been alerted. */
async function leakyUser(
  db: ScopedDb,
  n: number,
  options: { paidAt?: Date; deletedAt?: Date; optedOut?: boolean; internal?: boolean } = {},
): Promise<number> {
  const user = await db.one<{ user_key: number }>(
    `INSERT INTO end_users
       (project_id, external_id, paid_at, deleted_at, opted_out, internal,
        traits, signed_up_at, last_event_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $8)
     RETURNING user_key`,
    [
      db.projectId,
      `usr_${n}`,
      options.paidAt ?? null,
      options.deletedAt ?? null,
      options.optedOut ?? false,
      options.internal ?? false,
      JSON.stringify({ plan: 'Free' }),
      new Date('2026-11-01T00:00:00Z'),
    ],
  );

  await db.exec(
    `INSERT INTO leak_instances
       (project_id, subject_kind, subject_key, leak_type, episode_key, fired_at, says, details)
     VALUES ($1, 'user', $2, 'last-moment-drop', $3, $4, $5, '{}'::jsonb)`,
    [
      db.projectId,
      user.user_key,
      `checkout:${n}`,
      new Date('2026-11-10T09:00:00Z'),
      'They started checkout and no payment arrived within 2 hours.',
    ],
  );

  return user.user_key;
}

describe('the alert pipeline', () => {
  beforeAll(ensureMigrated);
  beforeEach(resetData);

  it('sends an alert in waking hours and records it in the feed', async () => {
    const projectId = await makeProject();
    await withProject(projectId, (db) => leakyUser(db, 1));

    const decided = await withProject(projectId, (db) => decideProjectAlerts(db, AWAKE));
    expect(decided.recorded).toBe(1);
    expect(decided.sending).toBe(1);

    const posts = recorder();
    const delivered = await withProject(projectId, (db) =>
      deliverDueAlerts(db, AWAKE, { post: posts.post }),
    );

    expect(delivered.sent).toBe(1);
    expect(posts.calls).toHaveLength(1);
    expect(posts.calls[0]?.url).toContain('hooks.slack.test');

    // Slack's documented shape: a notification string plus Block Kit blocks.
    const body = posts.calls[0]?.body as { text: string; blocks: { type: string }[] };
    expect(body.text).toContain('checkout');
    expect(body.blocks[0]?.type).toBe('section');

    const feed = await withProject(projectId, (db) => alertFeed(db, AWAKE));
    expect(feed).toHaveLength(1);
    expect(feed[0]?.delivery?.state).toBe('sent');
  });

  it('sends the first ten of a day and leaves the eleventh in the feed only', async () => {
    // M10 exit check.
    const projectId = await makeProject();
    await withProject(projectId, async (db) => {
      for (let n = 1; n <= 11; n++) await leakyUser(db, n);
    });

    const decided = await withProject(projectId, (db) => decideProjectAlerts(db, AWAKE));
    expect(decided.recorded).toBe(11);
    expect(decided.sending).toBe(DEFAULT_ALERTS_PER_DAY);
    expect(decided.overCap).toBe(1);

    const posts = recorder();
    await withProject(projectId, (db) => deliverDueAlerts(db, AWAKE, { post: posts.post }));
    expect(posts.calls).toHaveLength(DEFAULT_ALERTS_PER_DAY);

    // All eleven are in the feed; one of them says why it never left.
    const feed = await withProject(projectId, (db) => alertFeed(db, AWAKE));
    expect(feed).toHaveLength(11);
    const feedOnly = feed.filter((alert) => alert.route === 'feed-only');
    expect(feedOnly).toHaveLength(1);
    expect(feedOnly[0]?.because).toContain('daily limit');
    expect(feedOnly[0]?.delivery).toBeNull();
  });

  it('counts what already went out today, so the cap survives a second sweep', async () => {
    const projectId = await makeProject();
    await withProject(projectId, async (db) => {
      for (let n = 1; n <= 10; n++) await leakyUser(db, n);
    });

    const posts = recorder();
    await withProject(projectId, (db) => decideProjectAlerts(db, AWAKE));
    await withProject(projectId, (db) => deliverDueAlerts(db, AWAKE, { post: posts.post }));
    expect(posts.calls).toHaveLength(10);

    // A new leak, later the same local day: the cap is already spent.
    await withProject(projectId, (db) => leakyUser(db, 11));
    const second = await withProject(projectId, (db) => decideProjectAlerts(db, AWAKE));
    expect(second.sending).toBe(0);
    expect(second.overCap).toBe(1);
  });

  it('holds an alert raised in quiet hours until the morning', async () => {
    // M10 exit check.
    const projectId = await makeProject();
    await withProject(projectId, (db) => leakyUser(db, 1));

    const decided = await withProject(projectId, (db) => decideProjectAlerts(db, ASLEEP));
    expect(decided.held).toBe(1);
    expect(decided.sending).toBe(0);

    // Nothing goes out during the night.
    const night = recorder();
    const atNight = await withProject(projectId, (db) =>
      deliverDueAlerts(db, ASLEEP, { post: night.post }),
    );
    expect(atNight.sent).toBe(0);
    expect(night.calls).toHaveLength(0);

    // 08:00 Berlin is 07:00Z: now it is due.
    const morning = new Date('2026-11-11T07:00:00Z');
    const dawn = recorder();
    const atDawn = await withProject(projectId, (db) =>
      deliverDueAlerts(db, morning, { post: dawn.post }),
    );
    expect(atDawn.sent).toBe(1);
    expect(dawn.calls).toHaveLength(1);
  });

  it.each([
    ['paid since the leak was found', { paidAt: new Date('2026-11-10T10:00:00Z') }],
    ['asked to be deleted', { deletedAt: new Date('2026-11-10T10:00:00Z') }],
    ['opted out', { optedOut: true }],
    ['is on the founder’s own team', { internal: true }],
  ])('never alerts about someone who %s', async (_label, guard) => {
    // M10 exit check.
    const projectId = await makeProject();
    await withProject(projectId, (db) => leakyUser(db, 1, guard));

    const decided = await withProject(projectId, (db) => decideProjectAlerts(db, AWAKE));
    expect(decided.recorded).toBe(0);
    expect(decided.sending).toBe(0);

    const posts = recorder();
    await withProject(projectId, (db) => deliverDueAlerts(db, AWAKE, { post: posts.post }));
    expect(posts.calls).toHaveLength(0);

    // Not in the feed either: the feed is a list of things to act on.
    const feed = await withProject(projectId, (db) => alertFeed(db, AWAKE));
    expect(feed).toHaveLength(0);
  });

  it('writes one alert per leak however many times the sweep runs', async () => {
    const projectId = await makeProject();
    await withProject(projectId, (db) => leakyUser(db, 1));

    const first = await withProject(projectId, (db) => decideProjectAlerts(db, AWAKE));
    const second = await withProject(projectId, (db) => decideProjectAlerts(db, AWAKE));

    expect(first.recorded).toBe(1);
    // The second sweep sees the same open leak and must write nothing.
    expect(second.considered).toBe(0);
    expect(second.recorded).toBe(0);

    const feed = await withProject(projectId, (db) => alertFeed(db, AWAKE));
    expect(feed).toHaveLength(1);
  });

  it('retries a failed post with backoff, and gives up saying why', async () => {
    const projectId = await makeProject();
    await withProject(projectId, (db) => leakyUser(db, 1));
    await withProject(projectId, (db) => decideProjectAlerts(db, AWAKE));

    const posts = recorder({ ok: false, status: 500, detail: 'server error' });
    const first = await withProject(projectId, (db) =>
      deliverDueAlerts(db, AWAKE, { post: posts.post }),
    );
    expect(first.retrying).toBe(1);

    // Still inside the backoff: not due yet, so nothing is posted.
    const tooSoon = await withProject(projectId, (db) =>
      deliverDueAlerts(db, new Date(AWAKE.getTime() + 30_000), { post: posts.post }),
    );
    expect(tooSoon.sent + tooSoon.retrying).toBe(0);

    // Past the first backoff (60s), it tries again.
    const later = await withProject(projectId, (db) =>
      deliverDueAlerts(db, new Date(AWAKE.getTime() + 61_000), { post: posts.post }),
    );
    expect(later.retrying).toBe(1);
    expect(posts.calls.length).toBeGreaterThanOrEqual(2);

    const feed = await withProject(projectId, (db) => alertFeed(db, AWAKE));
    expect(feed[0]?.delivery?.lastError).toContain('500');
    expect(feed[0]?.delivery?.attempts).toBeGreaterThanOrEqual(2);
  });

  it('stops retrying a channel that is gone', async () => {
    const projectId = await makeProject();
    await withProject(projectId, (db) => leakyUser(db, 1));
    await withProject(projectId, (db) => decideProjectAlerts(db, AWAKE));

    const posts = recorder({ ok: false, status: 404, detail: 'channel_not_found' });
    const result = await withProject(projectId, (db) =>
      deliverDueAlerts(db, AWAKE, { post: posts.post }),
    );

    // A 404 means the channel or the app is gone: telling the founder beats retrying.
    expect(result.skipped).toBe(1);
    expect(result.retrying).toBe(0);
    const feed = await withProject(projectId, (db) => alertFeed(db, AWAKE));
    expect(feed[0]?.delivery?.state).toBe('skipped');
  });

  it('keeps everything in the feed when no chat app is connected', async () => {
    const created = await createProject({
      name: 'No channel',
      timezone: 'Europe/Berlin',
      settings: { alertChannel: 'none' },
    });
    await withProject(created.live.id, (db) => leakyUser(db, 1));

    const decided = await withProject(created.live.id, (db) => decideProjectAlerts(db, AWAKE));
    expect(decided.recorded).toBe(1);
    expect(decided.feedOnly).toBe(1);

    const feed = await withProject(created.live.id, (db) => alertFeed(db, AWAKE));
    expect(feed[0]?.because).toContain('No alert channel');
    expect(feed[0]?.delivery).toBeNull();
  });

  it('masks the person on a free project, in the feed and on the wire', async () => {
    const projectId = await makeProject();
    await withProject(projectId, async (db) => {
      await db.exec(
        `INSERT INTO end_users (project_id, external_id, traits, email_type)
         VALUES ($1, 'usr_named', '{"plan":"Free"}'::jsonb, 'work')`,
        [db.projectId],
      );
      const user = await db.one<{ user_key: number }>(
        `SELECT user_key FROM end_users WHERE project_id = $1 AND external_id = 'usr_named'`,
        [db.projectId],
      );
      await db.exec(
        `INSERT INTO leak_instances
           (project_id, subject_kind, subject_key, leak_type, episode_key, fired_at, says)
         VALUES ($1, 'user', $2, 'last-moment-drop', 'c1', $3, 'They started checkout.')`,
        [db.projectId, user.user_key, new Date('2026-11-10T09:00:00Z')],
      );
    });

    await withProject(projectId, (db) => decideProjectAlerts(db, AWAKE));
    const posts = recorder();
    await withProject(projectId, (db) => deliverDueAlerts(db, AWAKE, { post: posts.post }));

    const wire = JSON.stringify(posts.calls[0]?.body);
    const feed = await withProject(projectId, (db) => alertFeed(db, AWAKE));

    // The founder's own id for the person must not reach a free project's alert.
    expect(wire).not.toContain('usr_named');
    expect(JSON.stringify(feed)).not.toContain('usr_named');
    expect(feed[0]?.masked).toBe(true);
    // A tag instead, and it is stable.
    expect(wire).toMatch(/User [0-9A-F]{6}/);
  });

  it('counts unread alerts for the badge and clears them when read', async () => {
    const projectId = await makeProject();
    await withProject(projectId, async (db) => {
      for (let n = 1; n <= 3; n++) await leakyUser(db, n);
    });
    await withProject(projectId, (db) => decideProjectAlerts(db, AWAKE));

    expect(await withProject(projectId, unreadAlertCount)).toBe(3);
    const marked = await withProject(projectId, (db) => markFeedRead(db, AWAKE));
    expect(marked).toBe(3);
    expect(await withProject(projectId, unreadAlertCount)).toBe(0);
  });
});

describe('closing the pools', () => {
  it('closes', async () => {
    await closePools();
  });
});

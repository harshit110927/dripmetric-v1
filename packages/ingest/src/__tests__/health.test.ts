import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  alertFeed,
  closePools,
  createProject,
  openTrackingFindings,
  withProject,
  type ScopedDb,
} from '@dripmetric/db';
import { MISSING_EVENT_MIN_BASELINE, SHAPE_DRIFT_MIN_PRIOR } from '@dripmetric/engine';
import { checkTrackingHealth } from '../health/run.js';
import { runRetention, sweepUnclaimedProjects } from '../retention.js';
import { sourceToSmallInt } from '../pipeline/events.js';
import { ensureMigrated, resetData } from './helpers.js';

/**
 * Tracking health and retention against a real database (brief §9, §10, M11).
 *
 * Events are inserted directly rather than pushed through the pipeline: these checks
 * are about the SHAPE of a project's history — a 14-day baseline and a 24-hour hole in
 * it — and building that through the ingest API would take thousands of batches to
 * assert something the SQL can be handed directly.
 */

const NOW = new Date('2026-11-10T12:00:00Z');
const DAY = 86_400_000;
const HOUR = 3_600_000;

async function makeProject() {
  const created = await createProject({
    name: 'Health',
    timezone: 'Europe/Berlin',
    settings: { listPriceAmount: 4_900 },
  });
  return created.live.id;
}

/** An event name in the dictionary, confirmed as canonical. */
async function nameId(db: ScopedDb, canonical: string, firstSeen: Date): Promise<number> {
  const row = await db.one<{ id: number }>(
    `INSERT INTO event_names (project_id, raw_name, canonical, status, first_seen_at, last_seen_at)
     VALUES ($1, $2, $2, 'confirmed', $3, $3)
     ON CONFLICT (project_id, raw_name) DO UPDATE SET canonical = EXCLUDED.canonical
     RETURNING id`,
    [db.projectId, canonical, firstSeen],
  );
  return row.id;
}

/** `count` events of `name`, spread over a window ending `endsAgoHours` before NOW. */
async function addEvents(
  db: ScopedDb,
  id: number,
  options: {
    count: number;
    fromHoursAgo: number;
    toHoursAgo: number;
    source?: string;
    late?: boolean;
  },
): Promise<void> {
  const source = sourceToSmallInt((options.source ?? 'browser') as 'browser');
  const span = (options.fromHoursAgo - options.toHoursAgo) * HOUR;

  for (let i = 0; i < options.count; i++) {
    const at = new Date(
      NOW.getTime() - options.fromHoursAgo * HOUR + (span * i) / Math.max(1, options.count),
    );
    await db.exec(
      `INSERT INTO events
         (project_id, message_hash, name_id, user_key, occurred_at, received_at, source, flags)
       VALUES ($1, gen_random_uuid(), $2, NULL, $3, $3, $4, $5)`,
      [db.projectId, id, at, source, options.late === true ? 1 : 0],
    );
  }
}

describe('tracking health', () => {
  beforeAll(ensureMigrated);
  beforeEach(resetData);

  it('raises a TRACKING alert when a key event stops, not a "users vanished" one', async () => {
    // M11 exit check, and the sentence is the point.
    const projectId = await makeProject();

    await withProject(projectId, async (db) => {
      const id = await nameId(db, 'Signed Up', new Date(NOW.getTime() - 40 * DAY));
      // 14 days of history at ~5 a day, then nothing for the last 24 hours.
      await addEvents(db, id, { count: 70, fromHoursAgo: 24 * 15, toHoursAgo: 25 });
    });

    const result = await withProject(projectId, (db) => checkTrackingHealth(db, NOW));

    expect(result.recorded).toBe(1);
    const finding = result.findings[0];
    expect(finding?.kind).toBe('missing-event');
    expect(finding?.subject).toBe('Signed Up');

    // The wording requirement: tracking, not users.
    expect(finding?.says).toContain('tracking that stopped, not people who stopped');
    expect(finding?.says).toContain('No "Signed Up" has arrived');
    expect(finding?.fix).toContain('still runs');

    // And it reaches the feed, unmasked, with no channel delivery.
    const feed = await withProject(projectId, (db) => alertFeed(db, NOW));
    expect(feed).toHaveLength(1);
    expect(feed[0]?.title).toBe('An event stopped arriving');
    expect(feed[0]?.masked).toBe(false);
    expect(feed[0]?.delivery).toBeNull();
  });

  it('says nothing about an event that was never frequent enough to have a baseline', async () => {
    const projectId = await makeProject();
    await withProject(projectId, async (db) => {
      const id = await nameId(db, 'Invite Sent', new Date(NOW.getTime() - 40 * DAY));
      // Under the minimum baseline: a day's silence here is ordinary.
      await addEvents(db, id, {
        count: MISSING_EVENT_MIN_BASELINE * 14 - 10,
        fromHoursAgo: 24 * 15,
        toHoursAgo: 25,
      });
    });

    const result = await withProject(projectId, (db) => checkTrackingHealth(db, NOW));
    expect(result.findings.filter((f) => f.kind === 'missing-event')).toHaveLength(0);
  });

  it('raises the finding once however often the sweep runs, and closes it on return', async () => {
    const projectId = await makeProject();
    await withProject(projectId, async (db) => {
      const id = await nameId(db, 'Signed Up', new Date(NOW.getTime() - 40 * DAY));
      await addEvents(db, id, { count: 70, fromHoursAgo: 24 * 15, toHoursAgo: 25 });
    });

    const first = await withProject(projectId, (db) => checkTrackingHealth(db, NOW));
    const second = await withProject(projectId, (db) => checkTrackingHealth(db, NOW));
    expect(first.recorded).toBe(1);
    expect(second.recorded).toBe(0);
    expect(await withProject(projectId, openTrackingFindings)).toHaveLength(1);

    // The event comes back.
    await withProject(projectId, async (db) => {
      const id = await nameId(db, 'Signed Up', new Date(NOW.getTime() - 40 * DAY));
      await addEvents(db, id, { count: 6, fromHoursAgo: 6, toHoursAgo: 1 });
    });

    const third = await withProject(projectId, (db) => checkTrackingHealth(db, NOW));
    expect(third.resolved).toBeGreaterThanOrEqual(1);
    expect(await withProject(projectId, openTrackingFindings)).toHaveLength(0);
  });

  it('detects a property that changed type', async () => {
    // M11 exit check.
    const projectId = await makeProject();

    await withProject(projectId, async (db) => {
      const id = await nameId(db, 'Plan Selected', new Date(NOW.getTime() - 40 * DAY));
      await db.exec(
        `INSERT INTO event_name_properties
           (project_id, name_id, property, value_type, seen_count,
            prior_value_type, prior_seen_count, type_changed_at, first_seen_at, last_seen_at)
         VALUES ($1, $2, 'price', 'string', 40, 'number', $3, $4, $5, $4)`,
        [
          db.projectId,
          id,
          SHAPE_DRIFT_MIN_PRIOR + 5,
          new Date(NOW.getTime() - 2 * DAY),
          new Date(NOW.getTime() - 40 * DAY),
        ],
      );
    });

    const result = await withProject(projectId, (db) => checkTrackingHealth(db, NOW));
    const drift = result.findings.find((f) => f.kind === 'shape-drift');

    expect(drift?.subject).toBe('Plan Selected.price');
    expect(drift?.says).toContain('used to be a number and is now a string');
    expect(drift?.details['eventsWithOldType']).toBe(SHAPE_DRIFT_MIN_PRIOR + 5);
  });

  it('ignores a type change that only ever affected a handful of events', async () => {
    const projectId = await makeProject();
    await withProject(projectId, async (db) => {
      const id = await nameId(db, 'Plan Selected', new Date(NOW.getTime() - 40 * DAY));
      await db.exec(
        `INSERT INTO event_name_properties
           (project_id, name_id, property, value_type, seen_count,
            prior_value_type, prior_seen_count, type_changed_at, first_seen_at, last_seen_at)
         VALUES ($1, $2, 'price', 'string', 400, 'number', 2, $3, $4, $3)`,
        [db.projectId, id, new Date(NOW.getTime() - 2 * DAY), new Date(NOW.getTime() - 40 * DAY)],
      );
    });

    const result = await withProject(projectId, (db) => checkTrackingHealth(db, NOW));
    // A founder fixing their own bug in the first few events is not drift.
    expect(result.findings.filter((f) => f.kind === 'shape-drift')).toHaveLength(0);
  });

  it('detects a new property appearing on a long-known event', async () => {
    const projectId = await makeProject();
    await withProject(projectId, async (db) => {
      const id = await nameId(db, 'Core Action Done', new Date(NOW.getTime() - 60 * DAY));
      await db.exec(
        `INSERT INTO event_name_properties
           (project_id, name_id, property, value_type, seen_count, first_seen_at, last_seen_at)
         VALUES ($1, $2, 'variant', 'string', 300, $3, $3)`,
        [db.projectId, id, new Date(NOW.getTime() - 3 * DAY)],
      );
    });

    const result = await withProject(projectId, (db) => checkTrackingHealth(db, NOW));
    const drift = result.findings.find((f) => f.kind === 'shape-drift');
    expect(drift?.says).toContain('started carrying a new property, "variant"');
  });

  it('detects the same event arriving from two source paths', async () => {
    // M11 exit check: double-sent events.
    const projectId = await makeProject();

    await withProject(projectId, async (db) => {
      const id = await nameId(db, 'Subscription Started', new Date(NOW.getTime() - 40 * DAY));
      const user = await db.one<{ user_key: number }>(
        `INSERT INTO end_users (project_id, external_id, traits)
         VALUES ($1, 'usr_dup', '{}'::jsonb) RETURNING user_key`,
        [db.projectId],
      );

      // The same person, the same event, the same second, from browser AND server.
      for (let i = 0; i < 20; i++) {
        const at = new Date(NOW.getTime() - (i + 1) * HOUR);
        for (const source of ['browser', 'server'] as const) {
          await db.exec(
            `INSERT INTO events
               (project_id, message_hash, name_id, user_key, occurred_at, received_at, source)
             VALUES ($1, gen_random_uuid(), $2, $3, $4, $4, $5)`,
            [db.projectId, id, user.user_key, at, sourceToSmallInt(source)],
          );
        }
      }
    });

    const result = await withProject(projectId, (db) => checkTrackingHealth(db, NOW));
    const dup = result.findings.find((f) => f.kind === 'double-sent');

    expect(dup?.subject).toBe('Subscription Started');
    expect(dup?.says).toContain('arriving from 2 places at once');
    expect(dup?.says).toContain('browser and server');
    expect(dup?.fix).toContain('Send it from one place');
  });
});

describe('retention', () => {
  beforeAll(ensureMigrated);
  beforeEach(resetData);

  it('writes the summary first, then deletes only events past the window', async () => {
    // M11 exit check. 90 days on free (migration 0001 seeds it).
    const projectId = await makeProject();

    await withProject(projectId, async (db) => {
      const id = await nameId(db, 'Signed Up', new Date(NOW.getTime() - 200 * DAY));
      // Inside the window, and well outside it.
      await addEvents(db, id, { count: 10, fromHoursAgo: 24 * 10, toHoursAgo: 24 * 9 });
      await addEvents(db, id, { count: 15, fromHoursAgo: 24 * 120, toHoursAgo: 24 * 118 });
    });

    const before = await withProject(projectId, (db) =>
      db.one<{ n: string }>(`SELECT count(*) AS n FROM events WHERE project_id = $1`, [
        db.projectId,
      ]),
    );
    expect(Number(before.n)).toBe(25);

    const result = await runRetention(projectId, NOW);

    expect(result.ran).toBe(true);
    expect(result.retentionDays).toBe(90);
    expect(result.eventsDeleted).toBe(15);
    // The summary was written BEFORE the delete, which is the requirement.
    expect(result.summariesWritten).toBe(1);

    const after = await withProject(projectId, async (db) => ({
      events: Number(
        (
          await db.one<{ n: string }>(`SELECT count(*) AS n FROM events WHERE project_id = $1`, [
            db.projectId,
          ])
        ).n,
      ),
      summaries: Number(
        (
          await db.one<{ n: string }>(
            `SELECT count(*) AS n FROM daily_summaries WHERE project_id = $1`,
            [db.projectId],
          )
        ).n,
      ),
    }));

    expect(after.events).toBe(10);
    expect(after.summaries).toBeGreaterThan(0);
  });

  it('runs once a night however often the sweep fires', async () => {
    const projectId = await makeProject();
    const first = await runRetention(projectId, NOW);
    const second = await runRetention(projectId, new Date(NOW.getTime() + HOUR));

    expect(first.ran).toBe(true);
    expect(second.ran).toBe(false);
    expect(second.why).toContain('already ran');
  });

  it('deletes in batches by time range, so the table can be partitioned later', async () => {
    const projectId = await makeProject();
    await withProject(projectId, async (db) => {
      const id = await nameId(db, 'Page Viewed', new Date(NOW.getTime() - 300 * DAY));
      // Five distinct days, all past the window.
      for (let day = 100; day < 105; day++) {
        await addEvents(db, id, {
          count: 3,
          fromHoursAgo: 24 * day,
          toHoursAgo: 24 * day - 1,
        });
      }
    });

    const result = await runRetention(projectId, NOW);
    expect(result.eventsDeleted).toBe(15);
    // One batch per day-range, not one statement for everything.
    expect(result.batches).toBeGreaterThan(1);
  });

  it('stops ingesting for an unclaimed project at 14 days and deletes it at 30', async () => {
    const old = await createProject({ name: 'Abandoned' });
    const fresh = await createProject({ name: 'New' });

    // Backdate the abandoned one past both thresholds.
    await withProject(old.live.id, (db) =>
      db.exec(`UPDATE projects SET created_at = $2, claimed_at = NULL WHERE id = $1`, [
        db.projectId,
        new Date(NOW.getTime() - 40 * DAY),
      ]),
    );

    const result = await sweepUnclaimedProjects(NOW);
    expect(result.stopped).toBeGreaterThan(0);
    expect(result.deleted).toBeGreaterThan(0);

    const stillThere = await withProject(fresh.live.id, (db) =>
      db.maybeOne(`SELECT 1 FROM projects WHERE id = $1 AND deleted_at IS NULL`, [db.projectId]),
    );
    expect(stillThere).not.toBeNull();
  });
});

describe('closing the pools', () => {
  it('closes', async () => {
    await closePools();
  });
});

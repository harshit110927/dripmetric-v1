import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  closePools,
  createProject,
  markChange,
  reportRecipients,
  unsubscribeByToken,
  withProject,
  type ScopedDb,
} from '@dripmetric/db';
import { MIN_USERS_PER_WINDOW } from '@dripmetric/engine';
import {
  changeComparisons,
  runDailyDigest,
  runWeeklyReport,
  type OutgoingEmail,
} from '../alerts/reports.js';
import { decideProjectAlerts } from '../alerts/dispatch.js';
import { ensureMigrated, resetData } from './helpers.js';

/**
 * The weekly report, the digest and the Changes comparison against a real database
 * (brief §9, M10's exit checks).
 *
 * Email is injected, so nothing here calls Resend (CLAUDE.md rule 3).
 */

/** Monday 2 November 2026, 09:00 in Berlin (08:00Z). The report is due. */
const MONDAY_MORNING = new Date('2026-11-02T08:00:00Z');
/** Sunday, same hour: not due. */
const SUNDAY_MORNING = new Date('2026-11-01T08:00:00Z');
const DAY = 86_400_000;

function mailbox() {
  const sent: OutgoingEmail[] = [];
  return {
    sent,
    send: (email: OutgoingEmail) => {
      sent.push(email);
      return Promise.resolve();
    },
  };
}

async function makeProject(settings: Record<string, unknown> = {}) {
  const created = await createProject({
    name: 'Ledgerly',
    timezone: 'Europe/Berlin',
    settings: { listPriceAmount: 4_900, listPriceCurrency: 'usd', ...settings },
  });
  // A founder to email.
  await withProject(created.live.id, async (db) => {
    const user = await db.one<{ id: string }>(
      `INSERT INTO founder_users (email) VALUES ('founder@example.test') RETURNING id`,
    );
    await db.exec(`INSERT INTO project_members (project_id, user_id) VALUES ($1, $2)`, [
      db.projectId,
      user.id,
    ]);
  });
  return created.live.id;
}

/** Someone at high intent who never paid: the report's own headline. */
async function highIntentUser(db: ScopedDb, n: number): Promise<void> {
  const user = await db.one<{ user_key: number }>(
    `INSERT INTO end_users (project_id, external_id, traits, signed_up_at, last_event_at)
     VALUES ($1, $2, '{}'::jsonb, $3, $3) RETURNING user_key`,
    [db.projectId, `usr_${n}`, new Date('2026-10-28T00:00:00Z')],
  );
  await db.exec(
    `INSERT INTO intent_state
       (project_id, user_key, base_points, peak_score, peak_at, first_high_at,
        last_event_at, pricing_deliberation, checkout_started)
     VALUES ($1, $2, 70, 70, $3, $3, $3, true, true)`,
    [db.projectId, user.user_key, new Date('2026-10-29T00:00:00Z')],
  );
}

describe('the weekly leak report', () => {
  beforeAll(ensureMigrated);
  beforeEach(resetData);

  it('goes out on Monday morning in the founder’s timezone', async () => {
    const projectId = await makeProject();
    await withProject(projectId, async (db) => {
      for (let n = 1; n <= 7; n++) await highIntentUser(db, n);
    });

    const mail = mailbox();
    const result = await runWeeklyReport(projectId, MONDAY_MORNING, { send: mail.send });

    expect(result.ran).toBe(true);
    expect(result.recipients).toBe(1);
    expect(mail.sent).toHaveLength(1);
    // Brief §9 part 1's exact subject.
    expect(mail.sent[0]?.subject).toBe("7 users with buying intent didn't pay last week");
    expect(mail.sent[0]?.to).toBe('founder@example.test');
    expect(mail.sent[0]?.html).toContain('Buying intent');
  });

  it('does not go out on a Sunday, or before morning', async () => {
    const projectId = await makeProject();
    await withProject(projectId, (db) => highIntentUser(db, 1));

    const sunday = mailbox();
    const notYet = await runWeeklyReport(projectId, SUNDAY_MORNING, { send: sunday.send });
    expect(notYet.ran).toBe(false);
    expect(notYet.why).toContain('not Monday');
    expect(sunday.sent).toHaveLength(0);

    // 05:00 Berlin on the Monday: still too early.
    const dawn = mailbox();
    const early = await runWeeklyReport(projectId, new Date('2026-11-02T04:00:00Z'), {
      send: dawn.send,
    });
    expect(early.ran).toBe(false);
    expect(early.why).toContain('not yet morning');
  });

  it('sends once a week however often the hourly sweep runs', async () => {
    const projectId = await makeProject();
    await withProject(projectId, (db) => highIntentUser(db, 1));

    const mail = mailbox();
    const first = await runWeeklyReport(projectId, MONDAY_MORNING, { send: mail.send });
    // An hour later, the same sweep comes round again.
    const second = await runWeeklyReport(
      projectId,
      new Date(MONDAY_MORNING.getTime() + 3_600_000),
      {
        send: mail.send,
      },
    );

    expect(first.ran).toBe(true);
    expect(second.ran).toBe(false);
    expect(second.why).toContain('already went out');
    expect(mail.sent).toHaveLength(1);
  });

  it('sends nothing in a week with nothing in it', async () => {
    // A Monday email that says "nothing happened" is how a founder learns to filter us.
    const projectId = await makeProject();
    const mail = mailbox();

    const result = await runWeeklyReport(projectId, MONDAY_MORNING, { send: mail.send });
    expect(result.ran).toBe(false);
    expect(result.why).toContain('Nothing worth reporting');
    expect(mail.sent).toHaveLength(0);
  });

  it('carries a working one-click unsubscribe, and honours it next week', async () => {
    const projectId = await makeProject();
    await withProject(projectId, (db) => highIntentUser(db, 1));

    const mail = mailbox();
    await runWeeklyReport(projectId, MONDAY_MORNING, {
      send: mail.send,
      appUrl: 'https://app.example.test',
    });

    const link = /token=([A-Za-z0-9_-]+)/.exec(mail.sent[0]?.text ?? '');
    expect(link).not.toBeNull();

    const token = link?.[1] ?? '';
    const done = await withProject(projectId, (db) =>
      unsubscribeByToken(db, token, MONDAY_MORNING),
    );
    expect(done).toBe(true);

    // The following Monday: still due, but nobody wants it.
    const next = mailbox();
    const after = await runWeeklyReport(projectId, new Date(MONDAY_MORNING.getTime() + 7 * DAY), {
      send: next.send,
    });
    expect(after.recipients).toBe(0);
    expect(next.sent).toHaveLength(0);
  });

  it('hands out an unsubscribe token once, because only the hash is kept', async () => {
    const projectId = await makeProject();
    const first = await withProject(projectId, reportRecipients);
    const second = await withProject(projectId, reportRecipients);

    expect(first[0]?.unsubscribeToken).toBeTypeOf('string');
    // The row already exists, and its token is a hash we cannot reverse.
    expect(second[0]?.unsubscribeToken).toBeNull();
  });

  it('includes the payback line only when the price is in USD', async () => {
    const usd = await makeProject({ listPriceAmount: 900, listPriceCurrency: 'usd' });
    await withProject(usd, (db) => highIntentUser(db, 1));
    const usdMail = mailbox();
    await runWeeklyReport(usd, MONDAY_MORNING, { send: usdMail.send });
    // $9.00 → ceil(24.99 / 9) = 3.
    expect(usdMail.sent[0]?.text).toContain('Starter is $24.99');
    expect(usdMail.sent[0]?.text).toContain('saving 3');

    await resetData();
    const eur = await makeProject({ listPriceAmount: 900, listPriceCurrency: 'eur' });
    await withProject(eur, (db) => highIntentUser(db, 1));
    const eurMail = mailbox();
    await runWeeklyReport(eur, MONDAY_MORNING, { send: eurMail.send });
    expect(eurMail.sent[0]?.text).not.toContain('Starter is');
  });
});

describe('the daily digest', () => {
  beforeAll(ensureMigrated);
  beforeEach(resetData);

  /** 19:00 Berlin: the digest hour has passed. */
  const EVENING = new Date('2026-11-02T18:00:00Z');

  async function leakyUser(db: ScopedDb, n: number): Promise<void> {
    const user = await db.one<{ user_key: number }>(
      `INSERT INTO end_users (project_id, external_id, traits) VALUES ($1, $2, '{}'::jsonb)
       RETURNING user_key`,
      [db.projectId, `usr_${n}`],
    );
    await db.exec(
      `INSERT INTO leak_instances
         (project_id, subject_kind, subject_key, leak_type, episode_key, fired_at, says)
       VALUES ($1, 'user', $2, 'last-moment-drop', $3, $4, 'They started checkout.')`,
      [db.projectId, user.user_key, `c${n}`, EVENING],
    );
  }

  it('sends one digest on a day with alerts', async () => {
    const projectId = await makeProject({ alertChannel: 'email-digest' });
    await withProject(projectId, async (db) => {
      for (let n = 1; n <= 3; n++) await leakyUser(db, n);
    });
    await withProject(projectId, (db) => decideProjectAlerts(db, EVENING));

    const mail = mailbox();
    const result = await runDailyDigest(projectId, EVENING, { send: mail.send });

    expect(result.ran).toBe(true);
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]?.subject).toContain('3 leaks on Ledgerly');
    expect(mail.sent[0]?.text).toContain('Someone started checkout and did not pay — 3 times');
  });

  it('sends nothing on a day with no alerts', async () => {
    // Brief §9: "only on days with alerts".
    const projectId = await makeProject({ alertChannel: 'email-digest' });
    const mail = mailbox();
    const result = await runDailyDigest(projectId, EVENING, { send: mail.send });

    expect(result.ran).toBe(false);
    expect(result.why).toBe('No alerts today.');
    expect(mail.sent).toHaveLength(0);
  });

  it('sends nothing to a project that has a chat app', async () => {
    // Brief §9: the digest is for "founders with neither chat app".
    const projectId = await makeProject({ alertChannel: 'slack' });
    await withProject(projectId, (db) => leakyUser(db, 1));

    const mail = mailbox();
    const result = await runDailyDigest(projectId, EVENING, { send: mail.send });
    expect(result.ran).toBe(false);
    expect(result.why).toContain('chat app');
  });

  it('sends one digest a day however often the sweep runs', async () => {
    const projectId = await makeProject({ alertChannel: 'email-digest' });
    await withProject(projectId, (db) => leakyUser(db, 1));
    await withProject(projectId, (db) => decideProjectAlerts(db, EVENING));

    const mail = mailbox();
    await runDailyDigest(projectId, EVENING, { send: mail.send });
    const again = await runDailyDigest(projectId, new Date(EVENING.getTime() + 3_600_000), {
      send: mail.send,
    });

    expect(again.ran).toBe(false);
    expect(mail.sent).toHaveLength(1);
  });
});

describe('the before-and-after comparison', () => {
  beforeAll(ensureMigrated);
  beforeEach(resetData);

  const CHANGED_AT = new Date('2026-10-01T00:00:00Z');
  const NOW = new Date('2026-10-31T00:00:00Z');

  /** A funnel with one step, and `n` users either side of the change. */
  async function funnelWithTraffic(
    db: ScopedDb,
    before: { entered: number; completed: number },
    after: { entered: number; completed: number },
  ): Promise<string> {
    const funnel = await db.one<{ id: number }>(
      `INSERT INTO funnels (project_id, name, is_active) VALUES ($1, 'Main', true) RETURNING id`,
      [db.projectId],
    );
    const step = await db.one<{ id: number }>(
      `INSERT INTO funnel_steps (project_id, funnel_id, position, label, event_name, importance)
       VALUES ($1, $2, 1, 'Connect a data source', 'Core Action Done', 'key') RETURNING id`,
      [db.projectId, funnel.id],
    );

    let n = 0;
    const add = async (at: Date, count: number, completed: number) => {
      for (let i = 0; i < count; i++) {
        n++;
        const user = await db.one<{ user_key: number }>(
          `INSERT INTO end_users (project_id, external_id, traits) VALUES ($1, $2, '{}'::jsonb)
           RETURNING user_key`,
          [db.projectId, `u${n}`],
        );
        await db.exec(
          `INSERT INTO user_step_state
             (project_id, user_key, step_id, first_entered_at, first_completed_at, visits)
           VALUES ($1, $2, $3, $4, $5, 1)`,
          [db.projectId, user.user_key, step.id, at, i < completed ? at : null],
        );
      }
    };

    // Ten days either side of the change, inside the equal windows.
    await add(new Date(CHANGED_AT.getTime() - 10 * DAY), before.entered, before.completed);
    await add(new Date(CHANGED_AT.getTime() + 10 * DAY), after.entered, after.completed);

    const marked = await markChange(
      db,
      { stepId: step.id, happenedAt: CHANGED_AT, note: 'shortened the step 2 form' },
      null,
    );
    return marked.id;
  }

  it('says "too early to tell" under 100 users in a window', async () => {
    // M10 exit check.
    const projectId = await makeProject();
    await withProject(projectId, (db) =>
      funnelWithTraffic(db, { entered: 120, completed: 40 }, { entered: 40, completed: 20 }),
    );

    const [comparison] = await withProject(projectId, (db) => changeComparisons(db, NOW));
    expect(comparison?.comparison.verdict).toBe('too-early');
    expect(comparison?.comparison.says).toContain('Too early to tell');
    expect(comparison?.comparison.says).toContain(`${MIN_USERS_PER_WINDOW - 40} more users`);
  });

  it('prints the brief’s sentence once both windows are full, and freezes it', async () => {
    const projectId = await makeProject();
    await withProject(projectId, (db) =>
      funnelWithTraffic(db, { entered: 150, completed: 60 }, { entered: 150, completed: 90 }),
    );

    const [first] = await withProject(projectId, (db) => changeComparisons(db, NOW));
    expect(first?.comparison.verdict).toBe('improved');
    expect(first?.comparison.says).toContain('went from 40.0% to 60.0%');
    expect(first?.comparison.final).toBe(true);

    /*
     * Frozen: read back a week later, with a wider window available, the sentence is
     * the same one the founder was already told.
     */
    const [later] = await withProject(projectId, (db) =>
      changeComparisons(db, new Date(NOW.getTime() + 7 * DAY)),
    );
    expect(later?.comparison.says).toBe(first?.comparison.says);
  });

  it('appears in the weekly report as part 7', async () => {
    const projectId = await makeProject();
    await withProject(projectId, async (db) => {
      await funnelWithTraffic(db, { entered: 150, completed: 60 }, { entered: 150, completed: 90 });
      await highIntentUser(db, 900);
    });

    const mail = mailbox();
    // The Monday after `NOW`, so the change has both windows.
    await runWeeklyReport(projectId, new Date('2026-11-02T08:00:00Z'), { send: mail.send });

    expect(mail.sent[0]?.text).toContain('shortened the step 2 form');
    expect(mail.sent[0]?.text).toContain('went from 40.0% to 60.0%');
  });
});

describe('closing the pools', () => {
  it('closes', async () => {
    await closePools();
  });
});

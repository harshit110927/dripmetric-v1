import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closePools } from '../pool.js';
import { withProject, withoutProject } from '../scope.js';
import { createProject } from '../projects.js';
import { encrypt } from '../crypto.js';
import { entitlements } from '../entitlements.js';
import { intentPeople, leakPeople, serializeContext } from '../people.js';
import { revealPersonByKey, revealState, resolveTag } from '../reveals.js';
import { coarseTime, NAME_BAR, serializePerson } from '../serialize.js';
import { ensureMigrated, truncateAll } from './helpers.js';

/**
 * M9 exit checks (brief §11): "an automated scan shows a free project's API and HTML
 * contain no seeded email, name or user id while a paid project shows them" and "the
 * reveal allowance works (default 0)".
 *
 * Brief §2: "Masking is a commercial gate, not a privacy control (the founder owns
 * the data), so it must be airtight on our side." This is the test that makes
 * "airtight" a fact rather than an intention — it scans the serialized output for the
 * seeded strings rather than checking that particular fields look right, so a field
 * added later that forgets the gate fails here.
 */

const NOW = new Date('2026-10-29T12:00:00Z');

/** Values distinctive enough that finding them anywhere is unambiguous. */
const SEEDED = {
  externalId: 'usr_SEEDED_EXTERNAL_ID_42',
  email: 'seeded.person@scan-example.test',
  name: 'Seeded Scanperson',
  company: 'Scanco Limited',
  trait: 'SEEDED_TRAIT_VALUE',
};

async function seedProject(planCode: 'free' | 'starter'): Promise<{ id: number; userKey: number }> {
  const created = await createProject({ name: `Scan ${planCode}` });

  if (planCode !== 'free') {
    await withoutProject('admin-script', (db) =>
      db.exec('UPDATE projects SET plan_code = $2 WHERE id = $1', [created.live.id, planCode]),
    );
  }

  const userKey = await withProject(created.live.id, async (db) => {
    const email = encrypt(SEEDED.email);
    const names = encrypt(JSON.stringify({ name: SEEDED.name, company: SEEDED.company }));

    const row = await db.one<{ user_key: number }>(
      `INSERT INTO end_users (
         project_id, external_id, email_ciphertext, email_key_id, email_type,
         name_traits_ciphertext, name_traits_key_id, traits, country,
         signed_up_at, last_event_at
       ) VALUES ($1, $2, $3, $4, 'work', $5, $6, $7::jsonb, 'GB', $8, $8)
       RETURNING user_key`,
      [
        db.projectId,
        SEEDED.externalId,
        email.bytes,
        email.keyId,
        names.bytes,
        names.keyId,
        JSON.stringify({ plan: SEEDED.trait, role: 'owner' }),
        NOW,
      ],
    );

    // Intent state and an open leak, so the two list readers have something to show.
    await db.exec(
      `INSERT INTO intent_state (project_id, user_key, last_event_at, base_points, peak_score,
                                 first_high_at, activated, checkout_started, fit)
       VALUES ($1, $2, $3, 75, 75, $3, true, true, '{"workEmail":true}'::jsonb)`,
      [db.projectId, row.user_key, NOW],
    );
    await db.exec(
      `INSERT INTO leak_instances (project_id, subject_kind, subject_key, leak_type,
                                   episode_key, fired_at, says, details)
       VALUES ($1, 'user', $2, 'last-moment-drop', 'checkout:scan', $3,
               'They started checking out and no payment arrived.', '{}'::jsonb)`,
      [db.projectId, row.user_key, NOW],
    );

    return row.user_key;
  });

  return { id: created.live.id, userKey };
}

/** Everything the seeded person could be identified by. */
const SECRETS = [SEEDED.email, SEEDED.name, SEEDED.company, SEEDED.externalId, SEEDED.trait];

function scan(subject: unknown, label: string): void {
  const text = JSON.stringify(subject);
  for (const secret of SECRETS) {
    expect(text.includes(secret), `${label} leaked "${secret}"`).toBe(false);
  }
}

describe('the masking gate', () => {
  beforeAll(ensureMigrated, 60_000);
  beforeEach(truncateAll);
  afterAll(closePools);

  it('a free project’s serialized people contain no email, name, user id or trait', async () => {
    const { id } = await seedProject('free');

    const payload = await withProject(id, async (db) => {
      const context = await serializeContext(db, NOW);
      return {
        intent: await intentPeople(db, context),
        leaks: await leakPeople(db, context, 'last-moment-drop'),
      };
    });

    // The rows are there — the scan is not passing because the lists are empty.
    expect(payload.intent).toHaveLength(1);
    expect(payload.leaks).toHaveLength(1);

    scan(payload, 'a free project');

    const person = payload.intent[0]!.person;
    expect(person.masked).toBe(true);
    if (person.masked) {
      // What it DOES carry: a stable tag, a hint, a bar and a coarse time.
      expect(person.tag).toMatch(/^User [0-9A-F]{6}$/);
      expect(person.emailHint).toBe('work address');
      expect(person.nameBar).toBe(NAME_BAR);
      expect(person.traitsHint).toBe('2 traits');
      expect(person.lastSeen).toBe('today');
    }
  });

  it('a paid project shows them', async () => {
    const { id } = await seedProject('starter');

    const payload = await withProject(id, async (db) => {
      const context = await serializeContext(db, NOW);
      return await intentPeople(db, context);
    });

    const text = JSON.stringify(payload);
    expect(text).toContain(SEEDED.email);
    expect(text).toContain(SEEDED.name);
    expect(text).toContain(SEEDED.externalId);
    expect(text).toContain(SEEDED.trait);

    const person = payload[0]!.person;
    expect(person.masked).toBe(false);
    if (!person.masked) {
      expect(person.email).toBe(SEEDED.email);
      expect(person.name).toBe(SEEDED.name);
      expect(person.company).toBe(SEEDED.company);
      expect(person.userId).toBe(SEEDED.externalId);
    }
  });

  it('gives the same person the same tag every time, and different projects different tags', async () => {
    const one = await seedProject('free');
    const two = await seedProject('free');

    const tagOf = (id: number) =>
      withProject(id, async (db) => {
        const context = await serializeContext(db, NOW);
        const [row] = await intentPeople(db, context);
        const person = row!.person;
        return person.masked ? person.tag : null;
      });

    const first = await tagOf(one.id);
    const again = await tagOf(one.id);
    const other = await tagOf(two.id);

    // Stable per person, so a founder can follow one through the funnel …
    expect(again).toBe(first);
    // … and not matchable across projects, because the secret is per project
    // (settled decision 6).
    expect(other).not.toBe(first);
  });

  it('keeps times coarse, so a masked row cannot be matched against a log', () => {
    const now = new Date('2026-10-29T12:00:00Z');
    expect(coarseTime(new Date('2026-10-29T03:00:00Z'), now)).toBe('today');
    expect(coarseTime(new Date('2026-10-28T23:00:00Z'), now)).toBe('yesterday');
    expect(coarseTime(new Date('2026-10-25T10:00:00Z'), now)).toBe('this week');
    expect(coarseTime(new Date('2026-10-05T10:00:00Z'), now)).toBe('this month');
    expect(coarseTime(new Date('2026-01-05T10:00:00Z'), now)).toBe('earlier');
    expect(coarseTime(null, now)).toBe('not yet');
  });

  it('hides a name’s length behind a fixed-width bar', async () => {
    const { id } = await seedProject('free');
    const masked = await withProject(id, async (db) => {
      const context = await serializeContext(db, NOW);
      const [row] = await intentPeople(db, context);
      return row!.person;
    });

    expect(masked.masked).toBe(true);
    if (masked.masked) {
      // A bar as wide as the real name would answer "is this my one customer
      // called Jo?" from the screen.
      expect(masked.nameBar.length).toBe(NAME_BAR.length);
      expect(masked.nameBar.length).not.toBe(SEEDED.name.length);
    }
  });
});

describe('the reveal allowance', () => {
  beforeAll(ensureMigrated, 60_000);
  beforeEach(truncateAll);
  afterAll(closePools);

  it('is zero by default, and refuses with a reason', async () => {
    const { id, userKey } = await seedProject('free');

    const outcome = await withProject(id, async (db) => {
      const state = await revealState(db);
      expect(state.allowance).toBe(0);
      expect(state.everyone).toBe(false);
      expect(state.remaining).toBe(0);
      return revealPersonByKey(db, userKey, null, NOW);
    });

    expect(outcome.revealed).toBe(false);
    if (!outcome.revealed) expect(outcome.because).toContain('paid plan');
  });

  it('reveals exactly the person it was spent on', async () => {
    const { id, userKey } = await seedProject('free');

    // A second person, who stays masked.
    const otherKey = await withProject(id, async (db) => {
      const row = await db.one<{ user_key: number }>(
        `INSERT INTO end_users (project_id, external_id, first_seen_at, last_event_at)
         VALUES ($1, 'usr_OTHER', $2, $2) RETURNING user_key`,
        [db.projectId, NOW],
      );
      await db.exec(
        `INSERT INTO intent_state (project_id, user_key, last_event_at, base_points, peak_score)
         VALUES ($1, $2, $3, 70, 70)`,
        [db.projectId, row.user_key, NOW],
      );
      return row.user_key;
    });

    await withProject(id, (db) =>
      db.exec(
        `UPDATE projects SET settings = settings || '{"revealAllowance": 1}'::jsonb
                WHERE id = $1`,
        [db.projectId],
      ),
    );

    const outcome = await withProject(id, (db) => revealPersonByKey(db, userKey, null, NOW));
    expect(outcome.revealed).toBe(true);

    const people = await withProject(id, async (db) => {
      const context = await serializeContext(db, NOW);
      return intentPeople(db, context);
    });

    const revealed = people.find((row) => !row.person.masked);
    const stillMasked = people.find((row) => row.person.masked);

    expect(revealed).toBeDefined();
    expect(stillMasked).toBeDefined();
    if (revealed && !revealed.person.masked) {
      expect(revealed.person.email).toBe(SEEDED.email);
      expect(revealed.person.userKey).toBe(userKey);
    }
    expect(otherKey).not.toBe(userKey);
  });

  it('spends the allowance once per person, and refuses when it runs out', async () => {
    const { id, userKey } = await seedProject('free');
    await withProject(id, (db) =>
      db.exec(
        `UPDATE projects SET settings = settings || '{"revealAllowance": 1}'::jsonb
                WHERE id = $1`,
        [db.projectId],
      ),
    );

    const first = await withProject(id, (db) => revealPersonByKey(db, userKey, null, NOW));
    const again = await withProject(id, (db) => revealPersonByKey(db, userKey, null, NOW));

    expect(first.revealed).toBe(true);
    // Revealing the same person twice costs nothing.
    expect(again.revealed).toBe(true);
    if (again.revealed) expect(again.alreadyRevealed).toBe(true);

    const second = await withProject(id, async (db) => {
      const row = await db.one<{ user_key: number }>(
        `INSERT INTO end_users (project_id, external_id, first_seen_at, last_event_at)
         VALUES ($1, 'usr_THIRD', $2, $2) RETURNING user_key`,
        [db.projectId, NOW],
      );
      return revealPersonByKey(db, row.user_key, null, NOW);
    });

    expect(second.revealed).toBe(false);
    if (!second.revealed) expect(second.because).toContain('all 1');
  });

  it('writes every reveal to the audit log', async () => {
    const { id, userKey } = await seedProject('free');
    await withProject(id, (db) =>
      db.exec(
        `UPDATE projects SET settings = settings || '{"revealAllowance": 5}'::jsonb
                WHERE id = $1`,
        [db.projectId],
      ),
    );
    await withProject(id, (db) => revealPersonByKey(db, userKey, null, NOW));

    const rows = await withProject(id, (db) =>
      db.query<{ action: string; subject: string }>(
        `SELECT action, subject FROM audit_log
          WHERE project_id = $1 AND action = 'identity.revealed'`,
        [db.projectId],
      ),
    );
    expect(rows).toEqual([{ action: 'identity.revealed', subject: String(userKey) }]);
  });

  it('finds the person behind a tag, and nobody behind a wrong one', async () => {
    const { id, userKey } = await seedProject('free');

    const tag = await withProject(id, async (db) => {
      const context = await serializeContext(db, NOW);
      const [row] = await intentPeople(db, context);
      const person = row!.person;
      return person.masked ? person.tag : '';
    });

    expect(await withProject(id, (db) => resolveTag(db, tag))).toBe(userKey);
    expect(await withProject(id, (db) => resolveTag(db, 'User 000000'))).toBeNull();
    expect(await withProject(id, (db) => resolveTag(db, 'not a tag'))).toBeNull();
  });

  it('a paid project reveals everyone without spending anything', async () => {
    const { id, userKey } = await seedProject('starter');

    const state = await withProject(id, revealState);
    expect(state.everyone).toBe(true);

    const outcome = await withProject(id, (db) => revealPersonByKey(db, userKey, null, NOW));
    expect(outcome.revealed).toBe(true);

    const spent = await withProject(id, (db) =>
      db.query(`SELECT 1 FROM reveals WHERE project_id = $1`, [db.projectId]),
    );
    // Nothing was spent: the plan reveals everyone anyway.
    expect(spent).toEqual([]);
  });
});

describe('the serializer itself', () => {
  beforeAll(ensureMigrated, 60_000);
  afterAll(closePools);

  it('cannot be asked for a full person without the entitlement', async () => {
    // The gate is one function, and this is the call every list makes.
    const freeProject = await createProject({ name: 'Gate' });
    const plan = await withProject(freeProject.live.id, entitlements);

    const row = {
      userKey: 1,
      externalId: SEEDED.externalId,
      emailCiphertext: encrypt(SEEDED.email).bytes,
      emailKeyId: encrypt(SEEDED.email).keyId,
      emailType: 'work' as const,
      nameTraitsCiphertext: null,
      nameTraitsKeyId: null,
      traits: {},
      country: 'GB',
      signedUpAt: NOW,
      lastEventAt: NOW,
    };

    const masked = serializePerson(row, {
      entitlements: plan,
      projectSecret: Buffer.alloc(32, 7),
      now: NOW,
    });
    expect(masked.masked).toBe(true);
    scan(masked, 'the serializer with no entitlement');
  });
});

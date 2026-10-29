import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closePools } from '../pool.js';
import { withProject } from '../scope.js';
import { createProject } from '../projects.js';
import { updateSettings } from '../projects.js';
import {
  confirmFact,
  PAID_EVENT_NAME,
  PRODUCT_FACTS,
  paidEventArriving,
  setupState,
  unconfirmFact,
  type ProductFact,
} from '../facts.js';
import { coverageFacts } from '../coverage.js';
import { ensureMigrated, truncateAll } from './helpers.js';

/**
 * The five product facts and setup logic (brief §2, settled decision 9).
 *
 * The point of these tests is the gate: setup cannot finish without a paid event,
 * and nothing else about the product is blocked by setup being unfinished.
 */

async function project(): Promise<number> {
  const created = await createProject({ name: 'Facts' });
  return created.live.id;
}

/** A confirmed mapping with events behind it, as ingest would leave one. */
async function arriving(projectId: number, rawName: string, canonical: string, count = 3) {
  await withProject(projectId, (db) =>
    db.exec(
      `INSERT INTO event_names
         (project_id, raw_name, canonical, status, first_seen_at, last_seen_at, event_count, owning_source)
       VALUES ($1, $2, $3, 'confirmed', now(), now(), $4, 'server')`,
      [db.projectId, rawName, canonical, count],
    ),
  );
}

async function aFunnel(projectId: number) {
  await withProject(projectId, async (db) => {
    const funnel = await db.one<{ id: number }>(
      `INSERT INTO funnels (project_id, name) VALUES ($1, 'Onboarding') RETURNING id`,
      [db.projectId],
    );
    await db.exec(
      `INSERT INTO funnel_steps (project_id, funnel_id, position, label, event_name, importance)
       VALUES ($1, $2, 1, 'Signed up', 'Signed Up', 'key'),
              ($1, $2, 2, 'Made a thing', 'Activated', 'key')`,
      [db.projectId, funnel.id],
    );
  });
}

describe('the five product facts', () => {
  beforeAll(ensureMigrated, 60_000);
  beforeEach(truncateAll);
  afterAll(closePools);

  it('starts with five unconfirmed facts and no completed setup', async () => {
    const id = await project();
    const state = await withProject(id, setupState);

    expect(state.facts.map((f) => f.fact)).toEqual([...PRODUCT_FACTS]);
    expect(state.confirmedCount).toBe(0);
    expect(state.completedAt).toBeNull();
    expect(state.remaining).toHaveLength(5);
    // Every one is a question in plain language, not a field name.
    for (const fact of state.facts) {
      expect(fact.question).toMatch(/\?$/);
      expect(fact.why.length).toBeGreaterThan(20);
    }
  });

  it('refuses to confirm a fact there is nothing behind, and says why', async () => {
    const id = await project();

    const result = await withProject(id, (db) =>
      confirmFact(db, 'paidEvent', null, new Date('2026-10-29T10:00:00Z')),
    );

    expect(result.confirmed).toBe(false);
    expect(result.refusedBecause).toContain(PAID_EVENT_NAME);
    const state = await withProject(id, setupState);
    expect(state.confirmedCount).toBe(0);
  });

  it('pre-fills the paid event from the founder’s own name for it', async () => {
    const id = await project();
    await arriving(id, 'upgraded_to_pro', PAID_EVENT_NAME);

    const state = await withProject(id, setupState);
    const paid = state.facts.find((f) => f.fact === 'paidEvent')!;

    expect(paid.value).toBe('upgraded_to_pro');
    expect(paid.origin).toBe('observed');
    expect(paid.ready).toBe(true);
    expect(state.paidEventArriving).toBe(true);
  });

  /*
   * Settled decision 9: the paid event is required to finish setup. Four of five is
   * not setup finished, and the missing one is never allowed to be the paid event.
   */
  it('cannot finish setup without the paid event', async () => {
    const id = await project();
    await aFunnel(id);
    await arriving(id, 'made_a_thing', 'Activated');
    await withProject(id, (db) => updateSettings(db, null, { listPriceAmount: 2900 }));

    const now = new Date('2026-10-29T10:00:00Z');
    const four: ProductFact[] = ['steps', 'activation', 'price', 'trial'];
    for (const fact of four) {
      const result = await withProject(id, (db) => confirmFact(db, fact, null, now));
      expect(result.confirmed, fact).toBe(true);
      expect(result.setupCompleted, fact).toBe(false);
    }

    const state = await withProject(id, setupState);
    expect(state.confirmedCount).toBe(4);
    expect(state.completedAt).toBeNull();
    expect(state.remaining).toEqual(['Which event means someone has paid?']);
    expect(await withProject(id, paidEventArriving)).toBe(false);
  });

  it('finishes setup once the paid event arrives and all five are confirmed', async () => {
    const id = await project();
    await aFunnel(id);
    await arriving(id, 'made_a_thing', 'Activated');
    await arriving(id, 'upgraded_to_pro', PAID_EVENT_NAME);
    await withProject(id, (db) => updateSettings(db, null, { listPriceAmount: 2900 }));

    const now = new Date('2026-10-29T10:00:00Z');
    for (const fact of PRODUCT_FACTS) {
      await withProject(id, (db) => confirmFact(db, fact, null, now));
    }

    const state = await withProject(id, setupState);
    expect(state.confirmedCount).toBe(5);
    expect(state.completedAt).toEqual(now);
    expect(state.remaining).toEqual([]);
    expect(await withProject(id, paidEventArriving)).toBe(true);
  });

  it('reopens setup when a fact is unconfirmed', async () => {
    const id = await project();
    await aFunnel(id);
    await arriving(id, 'made_a_thing', 'Activated');
    await arriving(id, 'upgraded_to_pro', PAID_EVENT_NAME);
    const now = new Date('2026-10-29T10:00:00Z');
    for (const fact of PRODUCT_FACTS) {
      await withProject(id, (db) => confirmFact(db, fact, null, now));
    }

    await withProject(id, (db) => unconfirmFact(db, 'price', null));

    const state = await withProject(id, setupState);
    expect(state.completedAt).toBeNull();
    expect(state.confirmedCount).toBe(4);
  });

  it('records every confirmation in the audit log', async () => {
    const id = await project();
    await arriving(id, 'upgraded_to_pro', PAID_EVENT_NAME);
    await withProject(id, (db) => confirmFact(db, 'paidEvent', null, new Date()));

    const rows = await withProject(id, (db) =>
      db.query<{ action: string; subject: string }>(
        `SELECT action, subject FROM audit_log
          WHERE project_id = $1 AND action LIKE 'fact.%'`,
        [db.projectId],
      ),
    );
    expect(rows).toEqual([{ action: 'fact.confirmed', subject: 'paidEvent' }]);
  });

  /*
   * A mapping is a translation, not a promise. Counting one with no events behind it
   * would make the coverage checklist claim a number the dashboard cannot show.
   */
  it('does not count a mapped name with no events as coverage', async () => {
    const id = await project();
    await arriving(id, 'upgraded_to_pro', PAID_EVENT_NAME, 0);

    const facts = await withProject(id, coverageFacts);
    expect(facts.arriving.has(PAID_EVENT_NAME)).toBe(false);
    expect(await withProject(id, paidEventArriving)).toBe(false);

    const paid = (await withProject(id, setupState)).facts.find((f) => f.fact === 'paidEvent')!;
    // It is still pre-fillable — the founder may be about to send it — but the
    // dashboard's revenue numbers stay off until an event actually arrives.
    expect(paid.ready).toBe(true);
  });

  it('counts the Inbox as waiting, not as coverage', async () => {
    const id = await project();
    await withProject(id, (db) =>
      db.exec(
        `INSERT INTO event_names
           (project_id, raw_name, canonical, status, first_seen_at, last_seen_at, event_count, owning_source)
         VALUES ($1, 'thing_happened', NULL, 'unmapped', now(), now(), 9, 'browser')`,
        [db.projectId],
      ),
    );

    const facts = await withProject(id, coverageFacts);
    expect(facts.unmappedCount).toBe(1);
    expect(facts.arriving.size).toBe(0);
  });
});

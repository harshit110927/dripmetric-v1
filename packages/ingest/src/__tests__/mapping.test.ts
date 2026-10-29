import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  closePools,
  confirmMapping,
  coverageFacts,
  dictionary,
  inbox,
  withProject,
  type DictionaryEntry,
} from '@dripmetric/db';
import { coverage, type AskOptions, type AskResult } from '@dripmetric/engine';
import { ensureMigrated, newFixture, postBatch, resetData, track } from './helpers.js';
import { refreshDictionaryFacts } from '../dictionary-facts.js';
import { runSuggestions } from '../suggest-run.js';
import { queueRecompute, recomputeProject } from '../recompute.js';

/**
 * M5 exit checks (brief §11):
 *
 *   "the Inbox lists the unmapped names"
 *   "the mock AI proposes mappings"
 *   "confirming one recomputes history"
 *   "the scrub test shows no email, phone, id or token reaches the model prompt"
 *
 * The model is an injected function, so these run in CI without a network call and
 * without spending anything (CLAUDE.md rule 3). The mock records exactly what it was
 * given, which is what makes the scrub check a real check rather than a hope.
 */

/** A mock model. Records every prompt it is handed, and answers from a fixed map. */
function mockModel(mappings: Record<string, string | null>, options: { reply?: string } = {}) {
  const calls: AskOptions[] = [];
  const ask = async (prompt: AskOptions): Promise<AskResult> => {
    calls.push(prompt);
    if (options.reply !== undefined) {
      return { text: options.reply, inputTokens: 11, outputTokens: 22 };
    }
    return {
      text: JSON.stringify({
        mappings: Object.entries(mappings).map(([rawName, canonical]) => ({
          raw_name: rawName,
          canonical,
          confidence: 'medium',
          reason: `"${rawName}" looks like it.`,
        })),
      }),
      inputTokens: 3_912,
      outputTokens: 841,
    };
  };
  return { ask, calls };
}

function entry(entries: readonly DictionaryEntry[], rawName: string): DictionaryEntry {
  const found = entries.find((e) => e.rawName === rawName);
  if (!found)
    throw new Error(
      `No dictionary entry for "${rawName}". Have: ${entries.map((e) => e.rawName).join(', ')}`,
    );
  return found;
}

const NOW = new Date('2026-10-29T12:00:00Z');

describe('the event dictionary, the Inbox and the mock AI', () => {
  beforeAll(ensureMigrated, 60_000);
  beforeEach(resetData);
  afterAll(closePools);

  it('lists the founder’s own names in the Inbox and counts every occurrence', async () => {
    const { project, secretKey } = await newFixture();

    await postBatch(
      [
        track('workspace_spun_up', { userId: 'u1' }),
        track('workspace_spun_up', { userId: 'u2' }),
        track('workspace_spun_up', { userId: 'u3' }),
        // A catalog name, sent verbatim: mapped and confirmed on sight.
        track('Signed Up', { userId: 'u1' }),
      ],
      { key: secretKey },
    );

    const waiting = await withProject(project.live.id, inbox);
    expect(waiting.map((e) => e.rawName)).toEqual(['workspace_spun_up']);
    // The count is per occurrence, not per batch: three events, not one.
    expect(entry(waiting, 'workspace_spun_up').eventCount).toBe(3);

    const all = await withProject(project.live.id, dictionary);
    expect(entry(all, 'Signed Up').status).toBe('confirmed');
    expect(entry(all, 'Signed Up').canonical).toBe('Signed Up');
  });

  it('collects property keys, shapes and sequence positions for the prompt', async () => {
    const { project, secretKey } = await newFixture();

    await postBatch(
      [
        track('workspace_spun_up', {
          userId: 'u1',
          timestamp: '2026-10-29T09:00:00.000Z',
          properties: { plan: 'pro', seats: 3 },
        }),
        track('workspace_spun_up', {
          userId: 'u2',
          timestamp: '2026-10-29T09:05:00.000Z',
          properties: { plan: 'free', seats: 1 },
        }),
        track('thing_shared', {
          userId: 'u1',
          timestamp: '2026-10-29T09:10:00.000Z',
          properties: { channel: 'email' },
        }),
      ],
      { key: secretKey },
    );

    const result = await withProject(project.live.id, (db) => refreshDictionaryFacts(db, NOW));
    expect(result.namesSeen).toBeGreaterThan(0);

    const all = await withProject(project.live.id, dictionary);
    const spun = entry(all, 'workspace_spun_up');

    expect(spun.distinctUsers).toBe(2);
    // Both people send `workspace_spun_up` first, so its median position is 1;
    // `thing_shared` only ever comes second. Position is most of what tells one of a
    // founder's own names from another when the words do not help.
    expect(spun.medianSequencePosition).toBe(1);
    expect(entry(all, 'thing_shared').medianSequencePosition).toBe(2);

    const properties = Object.fromEntries(spun.properties.map((p) => [p.property, p]));
    expect(Object.keys(properties).sort()).toEqual(['plan', 'seats']);
    expect(properties['plan']).toMatchObject({ valueType: 'string', distinctValues: 2 });
    // Few distinct short values, so a sample is shown: that is the whole shape rule.
    expect(properties['plan']!.sample).toMatch(/^(pro|free)$/);
    expect(properties['seats']).toMatchObject({ valueType: 'number' });
  });

  /*
   * Brief §7: "Never send end-user personal data. Scrub emails, phone numbers, ids,
   * tokens, URLs with query strings and anything that looks like a name before the
   * prompt is built. Test the scrubber with a mock that records exactly what it
   * received."
   *
   * This is that test, at the level that matters: real events in, a real prompt out,
   * asserted against what a person's data actually looks like.
   */
  it('never lets an email, a token, an id or a URL reach the prompt', async () => {
    const { project, secretKey } = await newFixture();

    await postBatch(
      [
        track('invite_posted', {
          userId: 'u1',
          properties: {
            email: 'dana.patel@acme-example.com',
            inviteToken: 'key_live_EXAMPLEONLYNOTREAL',
            returnUrl: 'https://app.example.com/accept?token=abc123def456&uid=99',
            stripeCustomer: 'cus_EXAMPLEONLYNOTREAL99',
            fullName: 'Dana Patel',
            plan: 'pro',
          },
        }),
      ],
      { key: secretKey },
    );

    const model = mockModel({ invite_posted: 'Invite Sent' });
    const run = await withProject(project.live.id, (db) =>
      runSuggestions(db, null, NOW, model.ask),
    );

    expect(model.calls).toHaveLength(1);
    const prompt = `${model.calls[0]!.system}\n${model.calls[0]!.user}`;

    for (const secret of [
      'dana.patel@acme-example.com',
      'acme-example.com',
      'key_live_EXAMPLEONLYNOTREAL',
      'abc123def456',
      'cus_EXAMPLEONLYNOTREAL99',
      'Dana Patel',
    ]) {
      expect(prompt, `"${secret}" reached the prompt`).not.toContain(secret);
    }

    // The property KEYS are still there: the model has to know the shape.
    expect(prompt).toContain('email');
    expect(prompt).toContain('inviteToken');
    // And a safe, low-cardinality value still comes through.
    expect(prompt).toContain('plan');

    /*
     * Every withheld value is recorded with a reason, for the audit trail — and it
     * is recorded by the FIRST gate. `outcome.dropped` is the prompt builder's own
     * check, and it is empty here because nothing unsafe was ever stored to drop.
     * Reading the record off the second gate would have logged an empty list for
     * every real project, which is how this test earned its place.
     */
    expect(run.withheld.map((d) => d.property).sort()).toEqual([
      'email',
      'fullName',
      'inviteToken',
      'returnUrl',
      'stripeCustomer',
    ]);
    expect(run.outcome.dropped).toEqual([]);
  });

  it('stores the mock AI’s proposals as suggestions the founder can read', async () => {
    const { project, secretKey } = await newFixture();
    await postBatch(
      [
        track('workspace_spun_up', { userId: 'u1' }),
        track('thing_shared', { userId: 'u1' }),
        track('hit_the_wall', { userId: 'u1' }),
      ],
      { key: secretKey },
    );

    const model = mockModel({
      workspace_spun_up: 'Activated',
      thing_shared: 'Core Action',
      // "Nothing fits" is a real answer and better than a bad guess.
      hit_the_wall: null,
    });

    const run = await withProject(project.live.id, (db) =>
      runSuggestions(db, null, NOW, model.ask),
    );

    expect(run.outcome.failure).toBeNull();
    expect(run.outcome.attempts).toBe(1);
    expect(run.stored).toBe(3);
    expect(run.outcome.inputTokens).toBe(3_912);

    const waiting = await withProject(project.live.id, inbox);
    const spun = entry(waiting, 'workspace_spun_up');
    expect(spun.status).toBe('suggested');
    expect(spun.canonical).toBe('Activated');
    expect(spun.confidence).toBe('medium');
    expect(spun.reason).toContain('workspace_spun_up');

    // A suggestion is not a mapping: it still counts toward nothing.
    const facts = await withProject(project.live.id, coverageFacts);
    expect(facts.arriving.has('Activated')).toBe(false);
    expect(facts.unmappedCount).toBe(3);
  });

  it('records a failure and leaves the Inbox usable by hand when the model is unusable', async () => {
    const { project, secretKey } = await newFixture();
    await postBatch([track('workspace_spun_up', { userId: 'u1' })], { key: secretKey });

    const model = mockModel({}, { reply: 'I am afraid I cannot do that.' });
    const run = await withProject(project.live.id, (db) =>
      runSuggestions(db, null, NOW, model.ask),
    );

    expect(run.outcome.failure).not.toBeNull();
    expect(model.calls).toHaveLength(2); // the brief allows one retry
    expect(run.stored).toBe(0);

    // By hand still works, which is the point.
    const changed = await withProject(project.live.id, (db) =>
      confirmMapping(db, 'workspace_spun_up', 'Activated', null, NOW),
    );
    expect(changed).toBe(true);
    const waiting = await withProject(project.live.id, inbox);
    expect(waiting).toHaveLength(0);
  });

  it('does not overwrite a mapping the founder has already decided', async () => {
    const { project, secretKey } = await newFixture();
    await postBatch([track('workspace_spun_up', { userId: 'u1' })], { key: secretKey });

    await withProject(project.live.id, (db) =>
      confirmMapping(db, 'workspace_spun_up', 'Core Action', null, NOW),
    );

    const model = mockModel({ workspace_spun_up: 'Activated' });
    const run = await withProject(project.live.id, (db) =>
      runSuggestions(db, null, NOW, model.ask),
    );

    // Not even asked about: a confirmed name is not in the Inbox.
    expect(run.considered).toBe(0);
    const all = await withProject(project.live.id, dictionary);
    expect(entry(all, 'workspace_spun_up').canonical).toBe('Core Action');
  });

  /*
   * "Confirming one recomputes history" (brief §11). The funnel step is reached by
   * the canonical name, so a founder's own name only counts once it is mapped — and
   * then it has to count for events that arrived BEFORE the mapping existed.
   */
  it('rebuilds step state for events that arrived before the mapping', async () => {
    const { project, secretKey } = await newFixture();

    await withProject(project.live.id, async (db) => {
      const funnel = await db.one<{ id: number }>(
        `INSERT INTO funnels (project_id, name) VALUES ($1, 'Onboarding') RETURNING id`,
        [db.projectId],
      );
      await db.exec(
        `INSERT INTO funnel_steps (project_id, funnel_id, position, label, event_name, importance)
         VALUES ($1, $2, 1, 'Made a thing', 'Activated', 'key')`,
        [db.projectId, funnel.id],
      );
    });

    await postBatch(
      [track('workspace_spun_up', { userId: 'u1' }), track('workspace_spun_up', { userId: 'u2' })],
      { key: secretKey },
    );

    // Unmapped, so the step has not been reached by anyone.
    const before = await withProject(project.live.id, (db) =>
      db.query<{ count: string }>('SELECT count(*) FROM user_step_state'),
    );
    expect(Number(before[0]!.count)).toBe(0);

    const changed = await withProject(project.live.id, (db) =>
      confirmMapping(db, 'workspace_spun_up', 'Activated', null, NOW),
    );
    expect(changed).toBe(true);

    const queued = await withProject(project.live.id, (db) => queueRecompute(db, 'mapping'));
    expect(queued.alreadyQueued).toBe(false);
    const rebuilt = await recomputeProject(project.live.id, NOW);
    expect(rebuilt.eventsSeen).toBe(2);

    const after = await withProject(project.live.id, (db) =>
      db.query<{ count: string }>('SELECT count(*) FROM user_step_state'),
    );
    expect(Number(after[0]!.count)).toBe(2);

    // And now it counts toward coverage, because it is both mapped and arriving.
    const facts = await withProject(project.live.id, coverageFacts);
    expect(facts.arriving.has('Activated')).toBe(true);
    expect(coverage(facts).switchedOff.map((s) => s.metric)).not.toContain(
      'Who reaches activation',
    );
  });

  it('runs the suggestion with the facts refreshed, not with stale ones', async () => {
    const { project, secretKey } = await newFixture();
    await postBatch([track('workspace_spun_up', { userId: 'u1', properties: { plan: 'pro' } })], {
      key: secretKey,
    });

    // No explicit refreshDictionaryFacts call: runSuggestions does it itself, so a
    // founder who presses the button right after their first events sees real
    // properties rather than an empty list.
    const model = mockModel({ workspace_spun_up: 'Activated' });
    await withProject(project.live.id, (db) => runSuggestions(db, null, NOW, model.ask));

    expect(model.calls[0]!.user).toContain('plan: string, e.g. pro');
  });
});

import { describe, expect, it } from 'vitest';
import {
  EMPTY_FUNNEL,
  matchSteps,
  matchesPattern,
  mergeStepUpdates,
  type FunnelConfig,
  type StepUpdate,
} from '../pipeline/step-state.js';

/**
 * Step matching is a pure function of the funnel and the event, which is what lets
 * M6's funnel engine and the `recompute` job call it with no database at all.
 */
const FUNNEL: FunnelConfig = {
  steps: [
    { stepId: 1, label: 'Create account', eventName: 'Signed Up', urlPattern: null },
    { stepId: 2, label: 'Invite the team', eventName: null, urlPattern: '/onboarding/invite' },
    { stepId: 3, label: 'Import your data', eventName: null, urlPattern: '/onboarding/import-*' },
    { stepId: 4, label: 'Created first board', eventName: 'Activated', urlPattern: null },
  ],
};

describe('step matching (brief section 8.1)', () => {
  it('matches a step defined by a canonical event', () => {
    expect(matchSteps(FUNNEL, 'Signed Up', null, null)).toEqual([{ stepId: 1, kind: 'completed' }]);
    expect(matchSteps(FUNNEL, 'Activated', null, null)).toEqual([{ stepId: 4, kind: 'completed' }]);
  });

  it('matches a step by its URL rule, and reaching the page enters the step', () => {
    expect(matchSteps(FUNNEL, 'Page Viewed', null, '/onboarding/invite')).toEqual([
      { stepId: 2, kind: 'entered' },
    ]);
  });

  it('matches a wildcard URL rule', () => {
    expect(matchSteps(FUNNEL, 'Page Viewed', null, '/onboarding/import-csv')).toEqual([
      { stepId: 3, kind: 'entered' },
    ]);
    expect(matchSteps(FUNNEL, 'Page Viewed', null, '/onboarding/something-else')).toEqual([]);
  });

  it('matches the founder’s own step events by the step name they carry', () => {
    expect(matchSteps(FUNNEL, 'Onboarding Step Completed', 'Invite the team', null)).toEqual([
      { stepId: 2, kind: 'completed' },
    ]);
    expect(matchSteps(FUNNEL, 'Onboarding Step Viewed', 'Invite the team', null)).toEqual([
      { stepId: 2, kind: 'entered' },
    ]);
  });

  it('matches nothing for a step name the funnel does not have', () => {
    expect(matchSteps(FUNNEL, 'Onboarding Step Completed', 'Some other step', null)).toEqual([]);
  });

  it('matches nothing at all before the founder has a funnel', () => {
    expect(matchSteps(EMPTY_FUNNEL, 'Signed Up', null, '/onboarding/invite')).toEqual([]);
  });

  it('matches nothing for an unmapped event, which is what the Inbox is for', () => {
    // canonical is null while a raw name waits in the Inbox, so it counts toward nothing.
    expect(matchSteps(FUNNEL, null, null, null)).toEqual([]);
  });
});

describe('URL rule patterns', () => {
  it('matches exactly when there is no wildcard', () => {
    expect(matchesPattern('/pricing', '/pricing')).toBe(true);
    expect(matchesPattern('/pricing/annual', '/pricing')).toBe(false);
  });

  it('treats * as "anything"', () => {
    expect(matchesPattern('/onboarding/step-2', '/onboarding/step-*')).toBe(true);
    expect(matchesPattern('/onboarding/step-2/detail', '/onboarding/step-*')).toBe(true);
    expect(matchesPattern('/settings', '/onboarding/step-*')).toBe(false);
  });

  it('does not let a pattern’s punctuation act as a regular expression', () => {
    // '.' in a pattern must mean a literal dot, not "any character".
    expect(matchesPattern('/aXjson', '/a.json')).toBe(false);
    expect(matchesPattern('/a.json', '/a.json')).toBe(true);
  });
});

describe('merging a batch\u2019s step updates', () => {
  const at = (iso: string) => new Date(iso);
  const update = (over: Partial<StepUpdate> = {}): StepUpdate => ({
    userKey: 1,
    stepId: 2,
    kind: 'entered',
    at: at('2026-06-01T10:00:00Z'),
    activeSeconds: 0,
    sessionId: 100,
    ...over,
  });

  /*
   * This merge is not an optimisation. A multi-row INSERT ... ON CONFLICT DO UPDATE
   * whose own rows collide fails outright - "cannot affect row a second time" - and
   * a batch routinely carries two updates for one person and step, because entering
   * a step and completing it are two events. The simulator found it: 1,065 of 6,458
   * messages failed with a 500 the moment a funnel existed to match against.
   */
  it('collapses two updates for the same person and step into one row', () => {
    const merged = mergeStepUpdates([
      update({ kind: 'entered', at: at('2026-06-01T10:00:00Z') }),
      update({ kind: 'completed', at: at('2026-06-01T10:05:00Z') }),
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.firstEnteredAt?.toISOString()).toBe('2026-06-01T10:00:00.000Z');
    expect(merged[0]?.firstCompletedAt?.toISOString()).toBe('2026-06-01T10:05:00.000Z');
    expect(merged[0]?.attempts).toBe(2);
  });

  it('keeps the EARLIEST of each time, whatever order they arrive in', () => {
    // Order-insensitive is the whole design: a late event must not overwrite a
    // newer state (brief section 5).
    const forwards = mergeStepUpdates([
      update({ kind: 'entered', at: at('2026-06-01T10:00:00Z') }),
      update({ kind: 'entered', at: at('2026-06-01T12:00:00Z') }),
    ]);
    const backwards = mergeStepUpdates([
      update({ kind: 'entered', at: at('2026-06-01T12:00:00Z') }),
      update({ kind: 'entered', at: at('2026-06-01T10:00:00Z') }),
    ]);

    expect(forwards[0]?.firstEnteredAt?.toISOString()).toBe('2026-06-01T10:00:00.000Z');
    expect(backwards[0]?.firstEnteredAt?.toISOString()).toBe('2026-06-01T10:00:00.000Z');
  });

  it('keeps the LATEST event time', () => {
    const merged = mergeStepUpdates([
      update({ at: at('2026-06-01T10:00:00Z') }),
      update({ at: at('2026-06-01T12:00:00Z') }),
    ]);
    expect(merged[0]?.lastEventAt.toISOString()).toBe('2026-06-01T12:00:00.000Z');
  });

  it('sums active time rather than taking the last value', () => {
    const merged = mergeStepUpdates([
      update({ activeSeconds: 30 }),
      update({ activeSeconds: 45 }),
      update({ activeSeconds: 0 }),
    ]);
    expect(merged[0]?.activeSeconds).toBe(75);
  });

  /*
   * `visits` is no longer merged to a count here.
   *
   * It is "separate sessions spent on the step" (brief §8.1), and a count taken from
   * one batch could only ever know about that batch — a visitor who came back later
   * was counted again from one. So the merge carries the SESSIONS and
   * `applyStepUpdates` recounts them from `user_step_sessions`, which is a set.
   */
  it('carries the distinct sessions it saw, so visits can be recounted from them', () => {
    const twoSessions = mergeStepUpdates([
      update({ sessionId: 100 }),
      update({ sessionId: 100 }),
      update({ sessionId: 200 }),
    ]);
    expect(twoSessions[0]?.sessions.sort()).toEqual([100, 200]);

    // A server event with no session of its own records nothing: we know the person
    // did something, but not which visit it belonged to, and inventing one would
    // put a visit on a timeline that never happened.
    const noSession = mergeStepUpdates([update({ sessionId: null })]);
    expect(noSession[0]?.sessions).toEqual([]);
  });

  it('keeps different people and different steps apart', () => {
    const merged = mergeStepUpdates([
      update({ userKey: 1, stepId: 2 }),
      update({ userKey: 1, stepId: 3 }),
      update({ userKey: 2, stepId: 2 }),
    ]);
    expect(merged).toHaveLength(3);
  });

  it('returns nothing for an empty batch, so no statement is sent', () => {
    expect(mergeStepUpdates([])).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import { classifyStep, isCooling, isSkimmed, isStuck, hours } from '../funnel/classify.js';
import {
  applyFreeze,
  thresholdsFor,
  STALL_DEFAULT_SECONDS,
  STUCK_MAX_SECONDS,
  STUCK_MIN_SECONDS,
  type StepThresholds,
} from '../funnel/thresholds.js';
import { timingsForUser, type StepDefinition, type StepStateFact } from '../funnel/timing.js';

/**
 * M6 exit checks (brief §11): "fixtures cover stuck, cooling, rushed and the
 * highlight logic" and "thresholds freeze when a change is marked".
 *
 * Every fixture below is a sentence from brief §8.1 turned into a case.
 */

const NOW = new Date('2026-10-29T12:00:00.000Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function step(overrides: Partial<StepDefinition> = {}): StepDefinition {
  return {
    stepId: 1,
    position: 1,
    label: 'Import your data',
    importance: 'key',
    expectedSeconds: null,
    stallOverrideSeconds: null,
    ...overrides,
  };
}

function state(overrides: Partial<StepStateFact> = {}): StepStateFact {
  return {
    userKey: 1,
    stepId: 1,
    firstEnteredAt: new Date(NOW.getTime() - 2 * HOUR),
    firstCompletedAt: null,
    attempts: 1,
    visits: 1,
    activeSeconds: 60,
    lastEventAt: new Date(NOW.getTime() - 2 * HOUR),
    ...overrides,
  };
}

/** One person's timing for a one-step funnel. */
function timingOf(fact: StepStateFact, definition = step(), now = NOW) {
  return timingsForUser([fact], [definition], now)[0]!;
}

function thresholds(overrides: Partial<StepThresholds> = {}): StepThresholds {
  return {
    stepId: 1,
    completions: 50,
    rushedSeconds: 30,
    stuckActiveSeconds: 300,
    stuckElapsedSeconds: HOUR / 1000,
    coolingGapSeconds: 2 * (HOUR / 1000),
    computedAt: NOW,
    frozenByChangeId: null,
    ...overrides,
  };
}

describe('timing facts', () => {
  it('measures elapsed, active, the gap to the next step and the wait so far', () => {
    const definitions = [step({ stepId: 1, position: 1 }), step({ stepId: 2, position: 2 })];
    const facts: StepStateFact[] = [
      {
        ...state({ stepId: 1 }),
        firstEnteredAt: new Date('2026-10-29T09:00:00.000Z'),
        firstCompletedAt: new Date('2026-10-29T09:10:00.000Z'),
        activeSeconds: 420,
      },
      {
        ...state({ stepId: 2 }),
        firstEnteredAt: new Date('2026-10-29T11:00:00.000Z'),
        firstCompletedAt: null,
        lastEventAt: new Date('2026-10-29T11:30:00.000Z'),
        activeSeconds: 90,
      },
    ];

    const [first, second] = timingsForUser(facts, definitions, NOW);

    expect(first!.elapsedSeconds).toBe(600);
    expect(first!.activeSeconds).toBe(420);
    // Finished at 09:10, started the next step at 11:00.
    expect(first!.gapSeconds).toBe(110 * 60);
    expect(first!.idleSeconds).toBeNull(); // a finished step cannot go quiet
    expect(first!.completed).toBe(true);

    expect(second!.elapsedSeconds).toBeNull();
    expect(second!.waitingSeconds).toBe(60 * 60); // on it since 11:00
    expect(second!.idleSeconds).toBe(30 * 60); // nothing since 11:30
    expect(second!.gapSeconds).toBeNull();
  });

  it('measures the gap to the next step they actually entered, skipping the ones between', () => {
    const definitions = [
      step({ stepId: 1, position: 1 }),
      step({ stepId: 2, position: 2 }),
      step({ stepId: 3, position: 3 }),
    ];
    const facts: StepStateFact[] = [
      {
        ...state({ stepId: 1 }),
        firstEnteredAt: new Date('2026-10-29T09:00:00.000Z'),
        firstCompletedAt: new Date('2026-10-29T09:05:00.000Z'),
      },
      // Step 2 never entered.
      {
        ...state({ stepId: 3 }),
        firstEnteredAt: new Date('2026-10-29T09:20:00.000Z'),
      },
    ];

    const timings = timingsForUser(facts, definitions, NOW);
    expect(timings[0]!.gapSeconds).toBe(15 * 60);
    expect(timings[1]!.enteredAt).toBeNull();
  });
});

describe('stuck', () => {
  /*
   * Brief §8.1: "active time on a Key step past its 90th percentile, or no progress
   * past its 90th-percentile elapsed time (clamped between 1 and 72 hours). Stuck
   * users lose no intent points: they are a leak to rescue."
   */
  it('catches active time past the 90th percentile', () => {
    const timing = timingOf(state({ activeSeconds: 400 }));
    expect(isStuck({ step: step(), timing, thresholds: thresholds(), now: NOW })).toBe(true);
  });

  it('catches no progress past the elapsed bar', () => {
    const timing = timingOf(
      state({ activeSeconds: 10, lastEventAt: new Date(NOW.getTime() - 5 * HOUR) }),
    );
    expect(isStuck({ step: step(), timing, thresholds: thresholds(), now: NOW })).toBe(true);
  });

  it('leaves alone someone who is still working and inside both bars', () => {
    const timing = timingOf(
      state({ activeSeconds: 30, lastEventAt: new Date(NOW.getTime() - 5 * MINUTE) }),
    );
    expect(isStuck({ step: step(), timing, thresholds: thresholds(), now: NOW })).toBe(false);
  });

  it('is never stuck once the step is finished', () => {
    const timing = timingOf(
      state({ activeSeconds: 9_999, firstCompletedAt: new Date(NOW.getTime() - HOUR) }),
    );
    expect(isStuck({ step: step(), timing, thresholds: thresholds(), now: NOW })).toBe(false);
  });

  it('applies to Key steps only', () => {
    const timing = timingOf(state({ activeSeconds: 400 }));
    for (const importance of ['normal', 'optional'] as const) {
      expect(
        isStuck({ step: step({ importance }), timing, thresholds: thresholds(), now: NOW }),
      ).toBe(false);
    }
  });
});

describe('cooling', () => {
  /*
   * Brief §8.1: "no return within the 90th percentile of the step's usual gap."
   * It applies to someone who HAS finished and has not moved on.
   */
  it('catches someone who finished and has not come back', () => {
    const timing = timingOf(
      state({
        firstCompletedAt: new Date(NOW.getTime() - 5 * HOUR),
        lastEventAt: new Date(NOW.getTime() - 5 * HOUR),
      }),
    );
    expect(isCooling({ step: step(), timing, thresholds: thresholds(), now: NOW })).toBe(true);
  });

  it('leaves alone someone who came back within the usual gap', () => {
    const timing = timingOf(state({ firstCompletedAt: new Date(NOW.getTime() - 30 * MINUTE) }));
    expect(isCooling({ step: step(), timing, thresholds: thresholds(), now: NOW })).toBe(false);
  });

  it('is not cooling once they have started the next step', () => {
    const definitions = [step({ stepId: 1, position: 1 }), step({ stepId: 2, position: 2 })];
    const facts: StepStateFact[] = [
      { ...state({ stepId: 1 }), firstCompletedAt: new Date(NOW.getTime() - 5 * HOUR) },
      { ...state({ stepId: 2 }), firstEnteredAt: new Date(NOW.getTime() - 4 * HOUR) },
    ];
    const timing = timingsForUser(facts, definitions, NOW)[0]!;
    expect(isCooling({ step: step(), timing, thresholds: thresholds(), now: NOW })).toBe(false);
  });
});

describe('rushed, and the "skimmed" mark', () => {
  /*
   * Brief §8.1: "a step finished faster than its 10th percentile and then skipped or
   * errored is marked 'skimmed'." Both halves are required.
   */
  it('marks a fast finish followed by a skip or an error', () => {
    const timing = timingOf(
      state({
        firstEnteredAt: new Date(NOW.getTime() - 2 * HOUR),
        firstCompletedAt: new Date(NOW.getTime() - 2 * HOUR + 10_000),
      }),
    );
    const input = { step: step(), timing, thresholds: thresholds(), now: NOW };
    expect(isSkimmed({ ...input, thenSkippedOrErrored: true })).toBe(true);
    // Fast on its own is someone who knew what they were doing.
    expect(isSkimmed({ ...input, thenSkippedOrErrored: false })).toBe(false);
  });

  it('does not mark a normal-speed finish, even followed by a skip', () => {
    const timing = timingOf(
      state({
        firstEnteredAt: new Date(NOW.getTime() - 2 * HOUR),
        firstCompletedAt: new Date(NOW.getTime() - 2 * HOUR + 10 * MINUTE),
      }),
    );
    expect(
      isSkimmed({
        step: step(),
        timing,
        thresholds: thresholds(),
        now: NOW,
        thenSkippedOrErrored: true,
      }),
    ).toBe(false);
  });
});

describe('the expected time the founder set', () => {
  it('flags users who take longer, and says so in their words', () => {
    const timing = timingOf(
      state({
        firstEnteredAt: new Date(NOW.getTime() - 2 * HOUR),
        firstCompletedAt: new Date(NOW.getTime() - 2 * HOUR + 5 * MINUTE),
      }),
    );
    const result = classifyStep({
      step: step({ expectedSeconds: 120 }),
      timing,
      thresholds: thresholds(),
      now: NOW,
    });
    expect(result.flags).toContain('over-expected');
    expect(result.says.join(' ')).toContain('2 minutes');
  });
});

describe('every threshold is a percentile of the product’s own users', () => {
  const definitions = [step()];

  function completions(secondsEach: readonly number[]) {
    return secondsEach.map((seconds, index) =>
      timingOf(
        {
          ...state({ userKey: index + 1 }),
          firstEnteredAt: new Date(NOW.getTime() - 10 * HOUR),
          firstCompletedAt: new Date(NOW.getTime() - 10 * HOUR + seconds * 1000),
          activeSeconds: seconds,
        },
        definitions[0],
      ),
    );
  }

  it('judges a 20-second step and a 6-minute step against their own history', () => {
    const quick = thresholdsFor(step(), completions(Array.from({ length: 50 }, () => 20)), NOW);
    const slow = thresholdsFor(step(), completions(Array.from({ length: 50 }, () => 360)), NOW);

    expect(quick.rushedSeconds).toBe(20);
    expect(slow.rushedSeconds).toBe(360);
    expect(quick.stuckActiveSeconds).toBe(20);
    expect(slow.stuckActiveSeconds).toBe(360);
  });

  it('clamps the stuck bar between one hour and seventy-two hours', () => {
    // A step everyone finishes in 20 seconds must not call someone stuck after 18.
    const quick = thresholdsFor(step(), completions(Array.from({ length: 50 }, () => 20)), NOW);
    expect(quick.stuckElapsedSeconds).toBe(STUCK_MIN_SECONDS);

    // A step that genuinely takes a week must still call someone stuck eventually.
    const glacial = thresholdsFor(
      step(),
      completions(Array.from({ length: 50 }, () => 7 * 24 * 3600)),
      NOW,
    );
    expect(glacial.stuckElapsedSeconds).toBe(STUCK_MAX_SECONDS);
  });

  it('falls back to the stall default for a step nobody has finished', () => {
    const fresh = thresholdsFor(step(), [], NOW);
    expect(fresh.stuckElapsedSeconds).toBe(STALL_DEFAULT_SECONDS);
    expect(fresh.rushedSeconds).toBeNull();
    expect(fresh.completions).toBe(0);
  });

  it('lets the founder’s own stall override beat the percentile', () => {
    const overridden = thresholdsFor(
      step({ stallOverrideSeconds: 90 }),
      completions(Array.from({ length: 50 }, () => 7 * 24 * 3600)),
      NOW,
    );
    expect(overridden.stuckElapsedSeconds).toBe(90);
  });
});

describe('thresholds freeze when a change is marked', () => {
  /*
   * Brief §8.1: "Thresholds freeze when the founder marks a change, so a
   * before-and-after comparison is not measured against a moving bar."
   */
  it('uses the frozen numbers and says which change froze them', () => {
    const computed = [thresholds({ stuckActiveSeconds: 900, rushedSeconds: 120 })];
    const frozen = applyFreeze(computed, {
      changeId: 'change-7',
      frozenAt: new Date('2026-10-01T00:00:00.000Z'),
      thresholds: [
        {
          stepId: 1,
          completions: 40,
          rushedSeconds: 30,
          stuckActiveSeconds: 300,
          stuckElapsedSeconds: 3600,
          coolingGapSeconds: 7200,
        },
      ],
    });

    expect(frozen[0]!.stuckActiveSeconds).toBe(300);
    expect(frozen[0]!.rushedSeconds).toBe(30);
    expect(frozen[0]!.frozenByChangeId).toBe('change-7');
    expect(frozen[0]!.computedAt).toEqual(new Date('2026-10-01T00:00:00.000Z'));
  });

  it('leaves a step with no frozen entry on its live numbers', () => {
    const computed = [thresholds({ stepId: 1 }), thresholds({ stepId: 2, rushedSeconds: 99 })];
    const frozen = applyFreeze(computed, {
      changeId: 'change-7',
      frozenAt: NOW,
      thresholds: [
        {
          stepId: 1,
          completions: 1,
          rushedSeconds: 1,
          stuckActiveSeconds: 1,
          stuckElapsedSeconds: 3600,
          coolingGapSeconds: 1,
        },
      ],
    });

    expect(frozen[0]!.frozenByChangeId).toBe('change-7');
    expect(frozen[1]!.frozenByChangeId).toBeNull();
    expect(frozen[1]!.rushedSeconds).toBe(99);
  });

  it('is a no-op with nothing frozen', () => {
    const computed = [thresholds()];
    expect(applyFreeze(computed, null)).toEqual(computed);
  });
});

describe('durations in words', () => {
  it('reads the way a founder would say it', () => {
    expect(hours(45)).toBe('45 seconds');
    expect(hours(600)).toBe('10 minutes');
    expect(hours(7_200)).toBe('2 hours');
    expect(hours(5 * 86_400)).toBe('5 days');
  });
});

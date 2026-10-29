import { describe, expect, it } from 'vitest';
import {
  highlightStep,
  HARD_STEP_DROP_RATIO,
  MIN_PER_SIDE_FOR_RATIO,
} from '../funnel/highlight.js';
import { segmentSplits, segmentWarnings, type SegmentFact } from '../funnel/segments.js';
import { retentionCohorts, weekStart } from '../funnel/cohorts.js';
import type { StepDefinition, StepTiming } from '../funnel/timing.js';

/**
 * M6 exit check (brief §11): "fixtures cover stuck, cooling, rushed and the highlight
 * logic."
 *
 * Brief §8.1: "A Key step is highlighted when it is among the slowest in the funnel,
 * or when slow users drop far more often than fast ones. If slow users drop three
 * times as often, the step is hard; if users drop at the same rate at any speed, they
 * do not see the value. Say which, in plain words."
 */

const NOW = new Date('2026-10-29T12:00:00.000Z');

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

/**
 * A step's population, built from two groups.
 *
 * `fast` people take 10 seconds, `slow` people take 100, and each group has a share
 * who never finish. That is exactly the comparison the brief's rule is about.
 */
function population(options: {
  fastTotal: number;
  fastDropped: number;
  slowTotal: number;
  slowDropped: number;
}): StepTiming[] {
  const timings: StepTiming[] = [];
  let userKey = 0;

  const add = (seconds: number, completed: boolean) => {
    userKey += 1;
    timings.push({
      userKey,
      stepId: 1,
      enteredAt: new Date(NOW.getTime() - 3_600_000),
      completedAt: completed ? new Date(NOW.getTime() - 3_600_000 + seconds * 1000) : null,
      elapsedSeconds: completed ? seconds : null,
      activeSeconds: seconds,
      attempts: 1,
      visits: 1,
      gapSeconds: null,
      idleSeconds: completed ? null : 600,
      waitingSeconds: completed ? null : seconds,
      completed,
      reached: true,
    });
  };

  for (let i = 0; i < options.fastTotal; i++) add(10, i >= options.fastDropped);
  for (let i = 0; i < options.slowTotal; i++) add(100, i >= options.slowDropped);
  return timings;
}

const ONE_STEP = new Map<number, number | null>([[1, 55]]);

describe('the highlight rules', () => {
  it('calls a step hard when slow users drop three times as often', () => {
    const timings = population({
      fastTotal: 40,
      fastDropped: 4, // 10%
      slowTotal: 40,
      slowDropped: 16, // 40% — four times as often
    });

    const result = highlightStep({ step: step(), timings, funnelMedians: ONE_STEP });

    expect(result.highlighted).toBe(true);
    expect(result.reason).toBe('hard');
    expect(result.says).toContain('is hard');
    expect(result.says).toContain('times as often');
    // The numbers behind the words, so a screen can show its working.
    expect(result.evidence.slowDropRate).toBeCloseTo(0.4, 6);
    expect(result.evidence.fastDropRate).toBeCloseTo(0.1, 6);
    expect(result.evidence.slowUsers).toBe(40);
  });

  it('says they are not seeing the value when the rate is the same at any speed', () => {
    const timings = population({
      fastTotal: 40,
      fastDropped: 16, // 40%
      slowTotal: 40,
      slowDropped: 16, // 40%
    });

    const result = highlightStep({ step: step(), timings, funnelMedians: ONE_STEP });

    expect(result.highlighted).toBe(true);
    expect(result.reason).toBe('no-value');
    expect(result.says).toContain('not seeing why it is worth doing');
    // It says which of the two readings it is, which is the requirement.
    expect(result.says).toContain('not that the step is hard');
  });

  it('needs enough people on each side before comparing rates at all', () => {
    // A ratio that would scream "hard" on four people against four.
    const timings = population({ fastTotal: 4, fastDropped: 0, slowTotal: 4, slowDropped: 4 });
    const result = highlightStep({ step: step(), timings, funnelMedians: ONE_STEP });

    expect(result.reason).not.toBe('hard');
    expect(result.evidence.slowUsers).toBeLessThan(MIN_PER_SIDE_FOR_RATIO);
  });

  it('highlights a step that is among the slowest in the funnel', () => {
    const timings = population({ fastTotal: 30, fastDropped: 2, slowTotal: 30, slowDropped: 2 });
    const medians = new Map<number, number | null>([
      [1, 900], // this step: the slowest
      [2, 60],
      [3, 30],
      [4, 20],
    ]);

    const result = highlightStep({ step: step(), timings, funnelMedians: medians });

    expect(result.highlighted).toBe(true);
    expect(result.reason).toBe('slowest');
    expect(result.says).toContain('one of the slowest steps');
    expect(result.evidence.funnelRank).toBe(1);
    expect(result.evidence.stepsInFunnel).toBe(4);
  });

  it('leaves a fast, healthy step alone', () => {
    const timings = population({ fastTotal: 30, fastDropped: 1, slowTotal: 30, slowDropped: 1 });
    const medians = new Map<number, number | null>([
      [1, 20],
      [2, 600],
      [3, 900],
      [4, 1200],
    ]);

    const result = highlightStep({ step: step(), timings, funnelMedians: medians });
    expect(result.highlighted).toBe(false);
    expect(result.reason).toBeNull();
    expect(result.says).toBe('');
  });

  it('never highlights a step the founder marked Normal or Optional', () => {
    const timings = population({ fastTotal: 40, fastDropped: 4, slowTotal: 40, slowDropped: 16 });
    for (const importance of ['normal', 'optional'] as const) {
      const result = highlightStep({
        step: step({ importance }),
        timings,
        funnelMedians: ONE_STEP,
      });
      expect(result.highlighted, importance).toBe(false);
      // The evidence is still gathered: only the conclusion is withheld.
      expect(result.evidence.slowDropRate).toBeCloseTo(0.4, 6);
    }
  });

  it('uses three as the ratio the brief names', () => {
    expect(HARD_STEP_DROP_RATIO).toBe(3);
  });
});

describe('segment splits', () => {
  /*
   * Brief §8.1: "A step that 70% of users complete on Chrome desktop but 20% on
   * Safari for iPhone is a bug, not low intent: say so." That example is this test.
   */
  const facts: SegmentFact[] = [
    { dimension: 'browser', value: 'Chrome', entered: 100, completed: 70 },
    { dimension: 'browser', value: 'Safari', entered: 100, completed: 20 },
    { dimension: 'device', value: 'desktop', entered: 100, completed: 70 },
    { dimension: 'device', value: 'mobile', entered: 100, completed: 65 },
  ];

  it('says a 70-against-20 split is something broken, not low intent', () => {
    const warnings = segmentWarnings(segmentSplits(facts));

    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.dimension).toBe('browser');
    expect(warnings[0]!.value).toBe('Safari');
    expect(warnings[0]!.says).toContain('70% of people on Chrome');
    expect(warnings[0]!.says).toContain('only 20% on Safari');
    expect(warnings[0]!.says).toContain('something broken');
  });

  it('says nothing about a 70-against-65 split', () => {
    const warnings = segmentWarnings(segmentSplits(facts.filter((f) => f.dimension === 'device')));
    expect(warnings).toEqual([]);
  });

  it('says nothing about a segment of three people', () => {
    const warnings = segmentWarnings(
      segmentSplits([
        { dimension: 'browser', value: 'Chrome', entered: 100, completed: 70 },
        { dimension: 'browser', value: 'Firefox', entered: 3, completed: 0 },
      ]),
    );
    expect(warnings).toEqual([]);
  });

  it('reports "none" rather than null for a missing campaign', () => {
    const splits = segmentSplits([
      { dimension: 'campaign', value: null, entered: 40, completed: 10 },
    ]);
    expect(splits[0]!.completionRate).toBeCloseTo(0.25, 6);
    expect(splits[0]!.value).toBeNull();
    expect(splits[0]!.enough).toBe(true);
  });
});

describe('retention cohorts', () => {
  it('puts a week on its Monday, in UTC', () => {
    expect(weekStart(new Date('2026-10-29T23:00:00.000Z'))).toBe('2026-10-26'); // Thursday
    expect(weekStart(new Date('2026-10-26T00:00:00.000Z'))).toBe('2026-10-26'); // Monday
    expect(weekStart(new Date('2026-10-25T12:00:00.000Z'))).toBe('2026-10-19'); // Sunday
  });

  it('counts a return in the week itself, not "any time since"', () => {
    const signedUpAt = new Date('2026-09-07T10:00:00.000Z'); // a Monday
    const cohorts = retentionCohorts(
      [
        // Came back in week 1 and in week 4.
        { userKey: 1, signedUpAt, activeDays: ['2026-09-07', '2026-09-16', '2026-10-07'] },
        // Came back in week 1 only.
        { userKey: 2, signedUpAt, activeDays: ['2026-09-07', '2026-09-15'] },
        // Never came back.
        { userKey: 3, signedUpAt, activeDays: ['2026-09-07'] },
      ],
      new Date('2026-10-29T00:00:00.000Z'),
    );

    expect(cohorts).toHaveLength(1);
    expect(cohorts[0]!.users).toBe(3);
    expect(cohorts[0]!.retained[1]).toBe(2);
    expect(cohorts[0]!.retained[4]).toBe(1);
    expect(cohorts[0]!.week1Rate).toBeCloseTo(2 / 3, 6);
    expect(cohorts[0]!.week4Rate).toBeCloseTo(1 / 3, 6);
  });

  /*
   * A cohort that signed up yesterday has not FAILED week 4; it has not reached it.
   * Showing 0% would read as a catastrophe that has not happened.
   */
  it('leaves a week unreported until it has fully passed', () => {
    const cohorts = retentionCohorts(
      [
        {
          userKey: 1,
          signedUpAt: new Date('2026-10-26T10:00:00.000Z'),
          activeDays: ['2026-10-26'],
        },
      ],
      new Date('2026-10-29T00:00:00.000Z'),
    );

    expect(cohorts[0]!.completeWeeks).toBe(0);
    expect(cohorts[0]!.week1Rate).toBeNull();
    expect(cohorts[0]!.week4Rate).toBeNull();
  });

  it('groups people by the week they signed up', () => {
    const cohorts = retentionCohorts(
      [
        { userKey: 1, signedUpAt: new Date('2026-09-07T10:00:00.000Z'), activeDays: [] },
        { userKey: 2, signedUpAt: new Date('2026-09-10T10:00:00.000Z'), activeDays: [] },
        { userKey: 3, signedUpAt: new Date('2026-09-14T10:00:00.000Z'), activeDays: [] },
      ],
      new Date('2026-10-29T00:00:00.000Z'),
    );

    expect(cohorts.map((c) => [c.cohortWeek, c.users])).toEqual([
      ['2026-09-07', 2],
      ['2026-09-14', 1],
    ]);
  });
});

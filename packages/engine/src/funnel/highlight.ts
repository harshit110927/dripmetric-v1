import { rate } from './stats.js';
import { medianElapsed } from './thresholds.js';
import type { StepDefinition, StepTiming } from './timing.js';

/**
 * Which step to highlight, and what to say about it (brief §8.1).
 *
 * "A Key step is highlighted when it is among the slowest in the funnel, or when slow
 * users drop far more often than fast ones. If slow users drop three times as often,
 * the step is hard; if users drop at the same rate at any speed, they do not see the
 * value. Say which, in plain words."
 *
 * The last five words are the requirement. A highlight that cannot explain itself is
 * a coloured box, and a founder learns to ignore it.
 */

/** Brief §8.1: "If slow users drop three times as often, the step is hard". */
export const HARD_STEP_DROP_RATIO = 3;

/**
 * How close the drop rates have to be before "they do not see the value" is the
 * honest reading rather than a guess. Within a fifth of each other.
 */
export const SAME_RATE_TOLERANCE = 0.2;

/**
 * The share of the funnel's steps counted as "among the slowest".
 *
 * A quarter: in a four-step funnel that is the slowest step, in an eight-step funnel
 * the slowest two. Named because the brief says "among the slowest" and leaves the
 * line to us.
 */
export const SLOWEST_SHARE = 0.25;

/**
 * A comparison between two groups of people needs enough of both to mean anything.
 *
 * The same bar as the percentiles (`MIN_COMPLETIONS_FOR_PERCENTILES`), applied to
 * each side: ten fast and ten slow users. Below it the ratio swings wildly on one
 * person, and "this step is three times harder for slow users" would be noise with a
 * sentence attached.
 */
export const MIN_PER_SIDE_FOR_RATIO = 10;

export type HighlightReason = 'slowest' | 'hard' | 'no-value' | null;

export interface Highlight {
  stepId: number;
  highlighted: boolean;
  reason: HighlightReason;
  /** The plain words. Empty when nothing is highlighted. */
  says: string;
  /** The numbers behind the words, so the screen can show its working. */
  evidence: {
    medianSeconds: number | null;
    funnelRank: number | null;
    stepsInFunnel: number;
    slowDropRate: number | null;
    fastDropRate: number | null;
    slowUsers: number;
    fastUsers: number;
  };
}

export interface HighlightInput {
  step: StepDefinition;
  /** Every person who entered this step, finished or not. */
  timings: readonly StepTiming[];
  /** The median elapsed time of every step in the funnel, including this one. */
  funnelMedians: ReadonlyMap<number, number | null>;
}

export function highlightStep(input: HighlightInput): Highlight {
  const { step, timings, funnelMedians } = input;

  const median = medianElapsed(timings);
  const ranked = [...funnelMedians.entries()]
    .filter((entry): entry is [number, number] => entry[1] !== null)
    .sort((a, b) => b[1] - a[1]);
  const funnelRank = ranked.findIndex(([stepId]) => stepId === step.stepId);

  /*
   * Split by speed on the TIME THEY HAVE SPENT, not on whether they finished.
   *
   * Using elapsed time only would compare finishers with finishers and the drop rate
   * of each group would be zero. Someone still on the step has spent `waitingSeconds`
   * so far, and that is the number that decides which group they are in.
   */
  const withTime = timings.filter((t) => (t.elapsedSeconds ?? t.waitingSeconds) !== null);
  const split = median;

  const slow = split === null ? [] : withTime.filter((t) => spent(t) > split);
  const fast = split === null ? [] : withTime.filter((t) => spent(t) <= split);

  const slowDropRate = rate(slow.filter((t) => !t.completed).length, slow.length);
  const fastDropRate = rate(fast.filter((t) => !t.completed).length, fast.length);

  const evidence = {
    medianSeconds: median,
    funnelRank: funnelRank < 0 ? null : funnelRank + 1,
    stepsInFunnel: funnelMedians.size,
    slowDropRate,
    fastDropRate,
    slowUsers: slow.length,
    fastUsers: fast.length,
  };

  // Brief §8.1: Key steps only.
  if (step.importance !== 'key') {
    return { stepId: step.stepId, highlighted: false, reason: null, says: '', evidence };
  }

  const comparable =
    slowDropRate !== null &&
    fastDropRate !== null &&
    slow.length >= MIN_PER_SIDE_FOR_RATIO &&
    fast.length >= MIN_PER_SIDE_FOR_RATIO;

  if (comparable) {
    // "If slow users drop three times as often, the step is hard."
    if (fastDropRate > 0 && slowDropRate >= fastDropRate * HARD_STEP_DROP_RATIO) {
      return {
        stepId: step.stepId,
        highlighted: true,
        reason: 'hard',
        says: `"${step.label}" is hard. People who take longer than most give up ${Math.round(slowDropRate / fastDropRate)} times as often as people who get through it quickly, so the step itself is the problem.`,
        evidence,
      };
    }
    // A step nobody finishes quickly either: the fast group drops just as much.
    if (fastDropRate === 0 && slowDropRate >= 0.5) {
      return {
        stepId: step.stepId,
        highlighted: true,
        reason: 'hard',
        says: `"${step.label}" is hard. Everyone who takes longer than most gives up, and nobody who gets through it quickly does.`,
        evidence,
      };
    }

    // "If users drop at the same rate at any speed, they do not see the value."
    const sameRate =
      Math.abs(slowDropRate - fastDropRate) <= SAME_RATE_TOLERANCE * Math.max(slowDropRate, 0.0001);
    if (sameRate && slowDropRate >= 0.3) {
      return {
        stepId: step.stepId,
        highlighted: true,
        reason: 'no-value',
        says: `People leave "${step.label}" at the same rate however fast they go, so it is not that the step is hard — they are not seeing why it is worth doing.`,
        evidence,
      };
    }
  }

  // "Among the slowest in the funnel."
  const slowestCount = Math.max(1, Math.ceil(ranked.length * SLOWEST_SHARE));
  if (median !== null && funnelRank >= 0 && funnelRank < slowestCount) {
    return {
      stepId: step.stepId,
      highlighted: true,
      reason: 'slowest',
      says: `"${step.label}" is one of the slowest steps in your funnel.`,
      evidence,
    };
  }

  return { stepId: step.stepId, highlighted: false, reason: null, says: '', evidence };
}

function spent(timing: StepTiming): number {
  return timing.elapsedSeconds ?? timing.waitingSeconds ?? 0;
}

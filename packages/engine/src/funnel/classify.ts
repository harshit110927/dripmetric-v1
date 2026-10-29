import { overExpected, type StepThresholds } from './thresholds.js';
import type { StepDefinition, StepTiming } from './timing.js';

/**
 * What is happening to one person on one step (brief §8.1).
 *
 * Each flag is a sentence from the brief turned into a named rule, with the words the
 * founder reads kept next to the rule that produced them — so a number on a screen
 * can always say how it was computed (CLAUDE.md rule 7).
 */

export const STEP_FLAGS = ['stuck', 'cooling', 'skimmed', 'over-expected'] as const;
export type StepFlag = (typeof STEP_FLAGS)[number];

export interface ClassifyInput {
  step: StepDefinition;
  timing: StepTiming;
  thresholds: StepThresholds;
  /** Always a parameter; `packages/engine` never reads a clock (CLAUDE.md rule 9). */
  now: Date;
  /**
   * Brief §8.1 ("rushed"): a step finished faster than its 10th percentile "and then
   * skipped or errored" is marked skimmed. The second half of that rule is about what
   * happened AFTER the step, so the caller supplies it.
   */
  thenSkippedOrErrored?: boolean;
}

export interface Classification {
  flags: StepFlag[];
  /** One plain sentence per flag, in the same order. */
  says: string[];
}

/**
 * Stuck (brief §8.1): "active time on a Key step past its 90th percentile, or no
 * progress past its 90th-percentile elapsed time (clamped between 1 and 72 hours).
 * Stuck users lose no intent points: they are a leak to rescue."
 *
 * Key steps only, by the brief's own wording. An optional step nobody finishes is
 * not a person in trouble.
 */
export function isStuck(input: ClassifyInput): boolean {
  const { step, timing, thresholds } = input;
  if (step.importance !== 'key') return false;
  if (timing.completed || timing.enteredAt === null) return false;

  const activePast =
    thresholds.stuckActiveSeconds !== null && timing.activeSeconds > thresholds.stuckActiveSeconds;

  // "No progress past its 90th-percentile elapsed time": measured from their last
  // event on the step, not from entry, so someone still working is not called stuck.
  const noProgress =
    timing.idleSeconds !== null && timing.idleSeconds > thresholds.stuckElapsedSeconds;

  return activePast || noProgress;
}

/**
 * Cooling (brief §8.1): "no return within the 90th percentile of the step's usual
 * gap. Shown on the user's timeline and in the step's stall risk; it does not change
 * the went-quiet leak."
 *
 * The gap is the one between finishing this step and starting the next, so cooling
 * applies to someone who HAS finished and has not moved on.
 */
export function isCooling(input: ClassifyInput): boolean {
  const { timing, thresholds } = input;
  if (!timing.completed || thresholds.coolingGapSeconds === null) return false;
  // Already moved on: there is no gap left to measure.
  if (timing.gapSeconds !== null) return false;
  if (timing.completedAt === null) return false;

  const sinceCompleted = Math.max(0, (input.now.getTime() - timing.completedAt.getTime()) / 1000);
  return sinceCompleted > thresholds.coolingGapSeconds;
}

/**
 * Skimmed (brief §8.1): "a step finished faster than its 10th percentile and then
 * skipped or errored is marked 'skimmed'."
 *
 * Both halves are required. Finishing fast on its own is a person who knew what they
 * were doing, and calling that a problem would be the kind of number that teaches a
 * founder to distrust the product.
 */
export function isSkimmed(input: ClassifyInput): boolean {
  const { timing, thresholds } = input;
  if (!timing.completed || timing.elapsedSeconds === null) return false;
  if (thresholds.rushedSeconds === null) return false;
  if (input.thenSkippedOrErrored !== true) return false;
  return timing.elapsedSeconds < thresholds.rushedSeconds;
}

export function classifyStep(input: ClassifyInput): Classification {
  const flags: StepFlag[] = [];
  const says: string[] = [];
  const { step, timing, thresholds } = input;

  if (isStuck(input)) {
    flags.push('stuck');
    says.push(
      timing.activeSeconds > (thresholds.stuckActiveSeconds ?? Infinity)
        ? `They have spent longer actively on "${step.label}" than 9 in 10 people who finished it.`
        : `They started "${step.label}" and have done nothing on it since ${hours(thresholds.stuckElapsedSeconds)}.`,
    );
  }

  if (isCooling(input)) {
    flags.push('cooling');
    says.push(
      `They finished "${step.label}" but have not come back, and 9 in 10 people return within ${hours(thresholds.coolingGapSeconds!)}.`,
    );
  }

  if (isSkimmed(input)) {
    flags.push('skimmed');
    says.push(
      `They got through "${step.label}" faster than 9 in 10 people and then stopped, so they may have skipped past it rather than used it.`,
    );
  }

  if (overExpected(step, timing)) {
    flags.push('over-expected');
    says.push(
      `"${step.label}" took them longer than the ${hours(step.expectedSeconds!)} you expect it to take.`,
    );
  }

  return { flags, says };
}

/** Durations in the words a founder would use, not in seconds. */
export function hours(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)} seconds`;
  if (seconds < 90 * 60) return `${Math.round(seconds / 60)} minutes`;
  if (seconds < 48 * 60 * 60) return `${Math.round(seconds / 3600)} hours`;
  return `${Math.round(seconds / 86_400)} days`;
}

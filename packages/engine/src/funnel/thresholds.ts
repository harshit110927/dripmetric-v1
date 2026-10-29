import { internalMedian, percentile } from './stats.js';
import type { StepDefinition, StepTiming } from './timing.js';

/**
 * Every threshold is a percentile of the product's own users (brief §8.1).
 *
 * "So a 6-minute data import and a 20-second profile step are each judged against
 * their own history. Thresholds freeze when the founder marks a change, so a
 * before-and-after comparison is not measured against a moving bar."
 *
 * That second sentence is the whole reason this is a stored object rather than a
 * calculation done at read time. A frozen set is data; a recomputed one is an
 * opinion that changes under the founder while they are reading it.
 */

/** Brief §8.1: the stuck elapsed threshold is "clamped between 1 and 72 hours". */
export const STUCK_MIN_SECONDS = 60 * 60;
export const STUCK_MAX_SECONDS = 72 * 60 * 60;

/**
 * Settled decision 8: 24 hours is the stall default when a step has no history of
 * its own yet, and `stallOverrideSeconds` beats both.
 */
export const STALL_DEFAULT_SECONDS = 24 * 60 * 60;

export interface StepThresholds {
  stepId: number;
  /** How many completions the percentiles were computed from. */
  completions: number;
  /** p10 of elapsed time: faster than this is a candidate for "skimmed". */
  rushedSeconds: number | null;
  /** p90 of active time on the step. */
  stuckActiveSeconds: number | null;
  /** p90 of elapsed time, clamped to 1–72 hours. Never null: the default applies. */
  stuckElapsedSeconds: number;
  /** p90 of the gap to the next step: longer than this is "cooling". */
  coolingGapSeconds: number | null;
  /** When these were computed. */
  computedAt: Date;
  /**
   * Set when they are frozen by a marked change, with the change's id. A frozen set
   * is never recomputed, so a before-and-after is measured against a fixed bar.
   */
  frozenByChangeId: string | null;
}

/**
 * Computes a step's thresholds from its own users' history.
 *
 * `now` is a parameter and is only used to stamp the result, so two runs over the
 * same facts give the same numbers (CLAUDE.md rules 9 and 10).
 */
export function thresholdsFor(
  step: StepDefinition,
  timings: readonly StepTiming[],
  now: Date,
): StepThresholds {
  const elapsed = timings
    .filter((timing) => timing.elapsedSeconds !== null)
    .map((timing) => timing.elapsedSeconds!)
    .sort((a, b) => a - b);

  const active = timings
    .filter((timing) => timing.completed && timing.activeSeconds > 0)
    .map((timing) => timing.activeSeconds)
    .sort((a, b) => a - b);

  const gaps = timings
    .filter((timing) => timing.gapSeconds !== null)
    .map((timing) => timing.gapSeconds!)
    .sort((a, b) => a - b);

  const elapsedP90 = percentile(elapsed, 0.9);

  return {
    stepId: step.stepId,
    completions: elapsed.length,
    rushedSeconds: percentile(elapsed, 0.1),
    stuckActiveSeconds: percentile(active, 0.9),
    stuckElapsedSeconds: stuckElapsed(step, elapsedP90),
    coolingGapSeconds: percentile(gaps, 0.9),
    computedAt: now,
    frozenByChangeId: null,
  };
}

/**
 * The elapsed bar for "stuck", in priority order:
 *
 *  1. the founder's own override for this step (settled decision 8),
 *  2. this step's own 90th percentile, clamped to 1–72 hours (brief §8.1),
 *  3. the 24-hour default, for a step with no completions yet.
 *
 * The clamp is what stops a step that everyone finishes in four seconds from calling
 * someone stuck after a minute, and a step that genuinely takes two days from never
 * calling anyone stuck at all.
 */
function stuckElapsed(step: StepDefinition, elapsedP90: number | null): number {
  if (step.stallOverrideSeconds !== null) return step.stallOverrideSeconds;
  if (elapsedP90 === null) return STALL_DEFAULT_SECONDS;
  return Math.min(STUCK_MAX_SECONDS, Math.max(STUCK_MIN_SECONDS, elapsedP90));
}

/**
 * A frozen set of thresholds, as stored when the founder marked a change.
 *
 * Only the numbers are frozen, not the step definition: a founder who shortens a
 * step still has their change measured against the bar that was in place when they
 * made it.
 */
export interface FrozenThresholds {
  changeId: string;
  frozenAt: Date;
  thresholds: readonly Omit<StepThresholds, 'computedAt' | 'frozenByChangeId'>[];
}

/**
 * Applies a freeze: where a frozen set exists for a step, it wins outright.
 *
 * Deliberately not a merge. A half-frozen threshold set — this percentile from
 * before the change, that one from after — would answer "did my change help?" with a
 * number that means neither.
 */
export function applyFreeze(
  computed: readonly StepThresholds[],
  frozen: FrozenThresholds | null,
): StepThresholds[] {
  if (frozen === null) return [...computed];
  const byStep = new Map(frozen.thresholds.map((entry) => [entry.stepId, entry]));

  return computed.map((thresholds) => {
    const entry = byStep.get(thresholds.stepId);
    if (!entry) return thresholds;
    return {
      ...entry,
      computedAt: frozen.frozenAt,
      frozenByChangeId: frozen.changeId,
    };
  });
}

/**
 * The expected-time bar, if the founder set one (brief §8.1).
 *
 * "An optional expected time (for example 'under 2 minutes') flags users who take
 * longer." It is the founder's own claim about their product, not a percentile, so
 * it is never recomputed and never frozen.
 */
export function overExpected(step: StepDefinition, timing: StepTiming): boolean {
  if (step.expectedSeconds === null) return false;
  const taken = timing.elapsedSeconds ?? timing.waitingSeconds;
  if (taken === null) return false;
  return taken > step.expectedSeconds;
}

/** Used by the highlight rules to split "slower than most" from "faster than most". */
export function medianElapsed(timings: readonly StepTiming[]): number | null {
  return internalMedian(
    timings.filter((timing) => timing.elapsedSeconds !== null).map((t) => t.elapsedSeconds!),
  );
}

import { classifyStep, type StepFlag } from './classify.js';
import { highlightStep, type Highlight } from './highlight.js';
import {
  distribution,
  rate,
  EMPTY_DISTRIBUTION,
  MIN_COMPLETIONS_FOR_PERCENTILES,
  type Distribution,
} from './stats.js';
import { medianElapsed, type StepThresholds } from './thresholds.js';
import {
  segmentSplits,
  segmentWarnings,
  type SegmentFact,
  type SegmentSplit,
  type SegmentWarning,
} from './segments.js';
import { timeToValue, type StepDefinition, type StepTiming, type TimeToValue } from './timing.js';

/**
 * The funnel, assembled (brief §8.1 and §9's Funnel module).
 *
 * "Free shows: drop-off per step, median time to complete, users stuck now, an 8-week
 * trend per step, segment splits."
 *
 * A pure function over facts and `now`. The worker loads the facts, calls this, and
 * stores the result; the dashboard reads the stored result (CLAUDE.md rule 9).
 */

export interface StepFacts {
  step: StepDefinition;
  /** One per person who entered this step. */
  timings: readonly StepTiming[];
  thresholds: StepThresholds;
  segments: readonly SegmentFact[];
  /** Per week, the share who completed. Oldest first, up to 8 (brief §9). */
  trend: readonly { weekStart: string; entered: number; completed: number }[];
  /** People whose next action after this step was a skip or an error. */
  skippedOrErroredAfter?: ReadonlySet<number>;
}

export interface FunnelFacts {
  steps: readonly StepFacts[];
  /** Signed up and activated, for time to value. */
  signedUp: number;
  activated: number;
  paid: number;
  timeToValue: readonly TimeToValue[];
}

export interface StepReport {
  stepId: number;
  position: number;
  label: string;
  importance: StepDefinition['importance'];
  entered: number;
  completed: number;
  /** Entered and never completed. The number a founder actually asks for. */
  droppedOff: number;
  dropOffRate: number | null;
  completionRate: number | null;
  /** As of `now`. Not a historical count: "stuck" is a present tense. */
  stuckNow: number;
  flagCounts: Record<StepFlag, number>;
  /** Elapsed seconds to complete: median, middle half, slowest 10%, average. */
  elapsed: Distribution;
  /** Active seconds, for the same people. */
  active: Distribution;
  thresholds: StepThresholds;
  highlight: Highlight;
  segments: SegmentSplit[];
  segmentWarnings: SegmentWarning[];
  trend: readonly {
    weekStart: string;
    entered: number;
    completed: number;
    completionRate: number | null;
  }[];
  /** Why a median is missing, in words, when it is. */
  percentilesNote: string | null;
}

export interface FunnelReport {
  computedAt: Date;
  steps: StepReport[];
  signedUp: number;
  activated: number;
  paid: number;
  /** Signed Up → Activated, elapsed and active (brief §8.1). */
  timeToValue: { elapsed: Distribution; active: Distribution };
  /** The one step to look at first, if any stands out. */
  highlightedStepId: number | null;
}

export function funnelReport(facts: FunnelFacts, now: Date): FunnelReport {
  // Every step's internal median first: the highlight rules compare across the funnel.
  const funnelMedians = new Map<number, number | null>(
    facts.steps.map((stepFacts) => [stepFacts.step.stepId, medianElapsed(stepFacts.timings)]),
  );

  const steps = facts.steps
    .map((stepFacts) => reportStep(stepFacts, funnelMedians, now))
    .sort((a, b) => a.position - b.position);

  /*
   * One highlight, not several.
   *
   * "Say which, in plain words" only works if there is one answer. A funnel with four
   * highlighted steps tells a founder to look everywhere, which is the same as
   * telling them nothing. Hardest first, then the clearest "no value", then slowest.
   */
  const order: Highlight['reason'][] = ['hard', 'no-value', 'slowest'];
  const highlighted = steps
    .filter((step) => step.highlight.highlighted)
    .sort(
      (a, b) =>
        order.indexOf(a.highlight.reason) - order.indexOf(b.highlight.reason) ||
        b.droppedOff - a.droppedOff,
    );

  return {
    computedAt: now,
    steps,
    signedUp: facts.signedUp,
    activated: facts.activated,
    paid: facts.paid,
    timeToValue: {
      elapsed: distribution(
        facts.timeToValue
          .filter((entry) => entry.elapsedSeconds !== null)
          .map((entry) => entry.elapsedSeconds!),
      ),
      active: distribution(facts.timeToValue.map((entry) => entry.activeSeconds)),
    },
    highlightedStepId: highlighted[0]?.stepId ?? null,
  };
}

function reportStep(
  facts: StepFacts,
  funnelMedians: ReadonlyMap<number, number | null>,
  now: Date,
): StepReport {
  const { step, timings, thresholds } = facts;

  // Everyone who reached the step, which includes the people whose entry time we
  // never saw because the step is defined by a server event (see `StepTiming.reached`).
  const entered = timings.filter((timing) => timing.reached).length;
  const completed = timings.filter((timing) => timing.completed).length;

  const flagCounts: Record<StepFlag, number> = {
    stuck: 0,
    cooling: 0,
    skimmed: 0,
    'over-expected': 0,
  };

  for (const timing of timings) {
    const classification = classifyStep({
      step,
      timing,
      thresholds,
      now,
      thenSkippedOrErrored: facts.skippedOrErroredAfter?.has(timing.userKey) ?? false,
    });
    for (const flag of classification.flags) flagCounts[flag] += 1;
  }

  const elapsed = distribution(
    timings.filter((t) => t.elapsedSeconds !== null).map((t) => t.elapsedSeconds!),
  );
  const active = distribution(timings.filter((t) => t.completed).map((t) => t.activeSeconds));
  const splits = segmentSplits(facts.segments);

  return {
    stepId: step.stepId,
    position: step.position,
    label: step.label,
    importance: step.importance,
    entered,
    completed,
    droppedOff: entered - completed,
    dropOffRate: rate(entered - completed, entered),
    completionRate: rate(completed, entered),
    stuckNow: flagCounts.stuck,
    flagCounts,
    elapsed: entered === 0 ? EMPTY_DISTRIBUTION : elapsed,
    /*
     * A step whose entry time is never reported can show a drop-off but not a
     * duration. Saying so is the coverage checklist's job (`Signup Started` is on it
     * for exactly this reason); inventing an elapsed time of zero is not.
     */
    active,
    thresholds,
    highlight: highlightStep({ step, timings, funnelMedians }),
    segments: splits,
    segmentWarnings: segmentWarnings(splits),
    trend: facts.trend.map((week) => ({
      ...week,
      completionRate: rate(week.completed, week.entered),
    })),
    percentilesNote: elapsed.enough
      ? null
      : `${elapsed.count} ${elapsed.count === 1 ? 'person has' : 'people have'} finished this step. We show times once ${MIN_COMPLETIONS_FOR_PERCENTILES} have, so a median is not based on a handful of people.`,
  };
}

export { timeToValue };

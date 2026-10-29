import { rate } from './stats.js';

/**
 * Segment splits on every step (brief §8.1).
 *
 * "Segment splits (device, browser, operating system, country, channel, campaign) on
 * every step. A step that 70% of users complete on Chrome desktop but 20% on Safari
 * for iPhone is a bug, not low intent: say so."
 *
 * That example is the test case, and the sentence it produces is the deliverable.
 */

/** The six dimensions, exactly as the brief lists them. */
export const SEGMENT_DIMENSIONS = [
  'device',
  'browser',
  'os',
  'country',
  'channel',
  'campaign',
] as const;
export type SegmentDimension = (typeof SEGMENT_DIMENSIONS)[number];

/**
 * How far below the best segment a segment has to be before we call it a bug.
 *
 * Half. The brief's own example is 70% against 20%, which is well past this; the line
 * is drawn here so a 70-against-45 split is reported as a split and not as a defect.
 */
export const BUG_COMPLETION_RATIO = 0.5;

/**
 * A segment needs this many people before it is worth a sentence.
 *
 * Twenty, the same bar as the percentiles: "nobody on Safari for iPhone completed
 * this step" is a very different claim when it is two people.
 */
export const MIN_USERS_PER_SEGMENT = 20;

export interface SegmentFact {
  dimension: SegmentDimension;
  /** Null is a real answer — "no campaign" — and is reported as "none". */
  value: string | null;
  entered: number;
  completed: number;
}

export interface SegmentSplit extends SegmentFact {
  completionRate: number | null;
  /** True when this segment has enough people to draw a conclusion from. */
  enough: boolean;
}

export interface SegmentWarning {
  dimension: SegmentDimension;
  value: string;
  /** The plain sentence. */
  says: string;
  completionRate: number;
  bestValue: string;
  bestRate: number;
  entered: number;
}

export function segmentSplits(facts: readonly SegmentFact[]): SegmentSplit[] {
  return facts
    .map((fact) => ({
      ...fact,
      completionRate: rate(fact.completed, fact.entered),
      enough: fact.entered >= MIN_USERS_PER_SEGMENT,
    }))
    .sort(
      (a, b) =>
        a.dimension.localeCompare(b.dimension) ||
        (b.completionRate ?? -1) - (a.completionRate ?? -1) ||
        label(a.value).localeCompare(label(b.value)),
    );
}

/**
 * The sentences: where one segment completes a step far less often than the best.
 *
 * Compared against the BEST segment in the same dimension rather than against the
 * step's overall rate, because the overall rate already contains the bad segment —
 * comparing against it would hide exactly the split we are looking for.
 */
export function segmentWarnings(splits: readonly SegmentSplit[]): SegmentWarning[] {
  const warnings: SegmentWarning[] = [];

  for (const dimension of SEGMENT_DIMENSIONS) {
    const usable = splits.filter(
      (split) => split.dimension === dimension && split.enough && split.completionRate !== null,
    );
    if (usable.length < 2) continue;

    const best = usable.reduce((a, b) => (b.completionRate! > a.completionRate! ? b : a));
    if (best.completionRate! <= 0) continue;

    for (const split of usable) {
      if (split === best) continue;
      if (split.completionRate! > best.completionRate! * BUG_COMPLETION_RATIO) continue;

      warnings.push({
        dimension,
        value: label(split.value),
        completionRate: split.completionRate!,
        bestValue: label(best.value),
        bestRate: best.completionRate!,
        entered: split.entered,
        says:
          `${percent(best.completionRate!)} of people on ${label(best.value)} get through this step, but only ` +
          `${percent(split.completionRate!)} on ${label(split.value)}. ` +
          `That gap is usually something broken rather than people who were not interested.`,
      });
    }
  }

  return warnings;
}

function label(value: string | null): string {
  return value === null || value.length === 0 ? 'none' : value;
}

function percent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

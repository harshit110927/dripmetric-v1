/**
 * The numbers behind every step (brief §8.1).
 *
 * "Display: the median, the middle half (25th to 75th percentile) and the slowest
 * 10% (90th percentile), shown once 20 users have completed the step; the average
 * sits beside them."
 *
 * Pure arithmetic over a list of seconds. No clock, no I/O (CLAUDE.md rule 9).
 */

/**
 * Brief §8.1: percentiles are shown "once 20 users have completed the step".
 *
 * Below this they are not rounded, hedged or labelled "provisional" — they are
 * absent. A median of three people is a number a founder would act on, and it would
 * be wrong. The brief's own assumption list calls this out: "a median needs 20
 * activations".
 */
export const MIN_COMPLETIONS_FOR_PERCENTILES = 20;

export interface Distribution {
  /** How many values there were. Always shown, however small. */
  count: number;
  /** The average, which the brief shows beside the percentiles rather than instead. */
  average: number | null;
  /** Null until `count` reaches MIN_COMPLETIONS_FOR_PERCENTILES. */
  p10: number | null;
  p25: number | null;
  median: number | null;
  p75: number | null;
  p90: number | null;
  /** True when there were enough completions to show percentiles at all. */
  enough: boolean;
}

export const EMPTY_DISTRIBUTION: Distribution = {
  count: 0,
  average: null,
  p10: null,
  p25: null,
  median: null,
  p75: null,
  p90: null,
  enough: false,
};

/**
 * One percentile of an already-sorted list, by linear interpolation.
 *
 * Deliberately the same definition as Postgres `percentile_cont`, so a number
 * computed here and the same number computed in SQL cannot disagree — which they
 * would with nearest-rank, and the disagreement would look like a data bug.
 */
export function percentile(sorted: readonly number[], fraction: number): number | null {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0]!;

  const position = fraction * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower]!;
  return sorted[lower]! + (position - lower) * (sorted[upper]! - sorted[lower]!);
}

export function distribution(values: readonly number[]): Distribution {
  if (values.length === 0) return EMPTY_DISTRIBUTION;

  const sorted = [...values].sort((a, b) => a - b);
  const average = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  const enough = sorted.length >= MIN_COMPLETIONS_FOR_PERCENTILES;

  return {
    count: sorted.length,
    average,
    enough,
    p10: enough ? percentile(sorted, 0.1) : null,
    p25: enough ? percentile(sorted, 0.25) : null,
    median: enough ? percentile(sorted, 0.5) : null,
    p75: enough ? percentile(sorted, 0.75) : null,
    p90: enough ? percentile(sorted, 0.9) : null,
  };
}

/**
 * The median regardless of volume, for internal comparisons only.
 *
 * The highlight rules need to split users into "faster than most" and "slower than
 * most", and that split is meaningful well before 20 people. It is never shown to a
 * founder: `distribution().median` is the one that reaches a screen, and it stays
 * null until the bar is met.
 */
export function internalMedian(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return percentile(
    [...values].sort((a, b) => a - b),
    0.5,
  );
}

/** A share, with the "no one entered" case as null rather than as zero. */
export function rate(part: number, whole: number): number | null {
  if (whole <= 0) return null;
  return part / whole;
}

/**
 * The one-sided Poisson test behind the step-completion collapse (brief §8.3).
 *
 * "Hourly per step: the last 24 hours against the trailing 14-day rate, with a
 * one-sided Poisson test (completions far below expected). Fires below p = 0.01 and
 * only when at least 10 completions were expected."
 *
 * Counts of independent events in a fixed window are Poisson, which is why this test
 * and not a percentage drop: a step that normally gets 12 completions a day and got 6
 * is noise, and the same halving on a step that gets 1,200 a day is an outage. A
 * percentage cannot tell those apart; a probability can.
 */

/** Brief §8.3: "Fires below p = 0.01". */
export const COLLAPSE_P_THRESHOLD = 0.01;
/** Brief §8.3: "only when at least 10 completions were expected". */
export const COLLAPSE_MIN_EXPECTED = 10;
/** Brief §8.3: "the last 24 hours against the trailing 14-day rate". */
export const COLLAPSE_WINDOW_HOURS = 24;
export const COLLAPSE_BASELINE_DAYS = 14;

/**
 * P(X ≤ k) for a Poisson with mean λ: the chance of seeing this few or fewer.
 *
 * Computed with a recurrence in ordinary numbers rather than `Math.pow(λ, i) / i!`,
 * which overflows to Infinity/NaN for a λ in the hundreds — and a λ in the hundreds
 * is exactly the busy step whose collapse matters most.
 */
export function poissonCdf(k: number, lambda: number): number {
  if (lambda <= 0) return k >= 0 ? 1 : 0;
  if (k < 0) return 0;

  // Work in logs for the leading term, then step the rest up multiplicatively.
  const logP0 = -lambda;
  let term = Math.exp(logP0);
  let sum = term;

  for (let i = 1; i <= Math.floor(k); i++) {
    term *= lambda / i;
    sum += term;
    if (!Number.isFinite(sum)) return 1;
  }

  return Math.min(1, Math.max(0, sum));
}

export interface CollapseTest {
  /** Completions in the last 24 hours. */
  observed: number;
  /** What the trailing 14-day rate predicted for 24 hours. */
  expected: number;
  /** P(X ≤ observed) under that rate. */
  p: number;
  /** True when it fires: enough was expected AND the shortfall is that unlikely. */
  collapsed: boolean;
  /** Why not, when it does not fire. Shown so a founder is never left guessing. */
  because: string | null;
}

/**
 * Tests one step's last 24 hours against its own trailing rate.
 *
 * The minimum-expected check comes first and is not negotiable. Without it a step
 * that usually gets two completions a day and got none would fire at p = 0.13 on a
 * quiet Sunday, and the founder would learn to ignore the alert that matters.
 */
export function collapseTest(
  observed: number,
  baselineCompletions: number,
  baselineDays = COLLAPSE_BASELINE_DAYS,
  windowHours = COLLAPSE_WINDOW_HOURS,
): CollapseTest {
  const expected = (baselineCompletions / baselineDays) * (windowHours / 24);
  const p = poissonCdf(observed, expected);

  if (expected < COLLAPSE_MIN_EXPECTED) {
    return {
      observed,
      expected,
      p,
      collapsed: false,
      because: `This step usually gets about ${expected.toFixed(1)} completions a day, and we need at least ${COLLAPSE_MIN_EXPECTED} expected before a quiet day means anything.`,
    };
  }

  if (p > COLLAPSE_P_THRESHOLD) {
    return {
      observed,
      expected,
      p,
      collapsed: false,
      because: `${observed} completions against about ${expected.toFixed(1)} expected is within normal variation.`,
    };
  }

  return { observed, expected, p, collapsed: true, because: null };
}

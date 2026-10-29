import { describe, expect, it } from 'vitest';
import {
  distribution,
  percentile,
  internalMedian,
  rate,
  MIN_COMPLETIONS_FOR_PERCENTILES,
} from '../funnel/stats.js';

/**
 * M6 exit check (brief §11): "percentiles appear only after 20 completions."
 *
 * Brief §8.1 and the brief's own assumption list ("a median needs 20 activations").
 * The rule is absence, not rounding: a median of three people is a number a founder
 * would act on and it would be wrong.
 */
describe('step statistics', () => {
  it('shows no percentile until twenty people have completed the step', () => {
    for (let count = 0; count < MIN_COMPLETIONS_FOR_PERCENTILES; count++) {
      const values = Array.from({ length: count }, (_, i) => i + 1);
      const result = distribution(values);

      expect(result.enough, `${count} completions`).toBe(false);
      expect(result.median, `${count} completions`).toBeNull();
      expect(result.p10).toBeNull();
      expect(result.p25).toBeNull();
      expect(result.p75).toBeNull();
      expect(result.p90).toBeNull();
      // The count and the average are always honest, however small.
      expect(result.count).toBe(count);
      if (count > 0) expect(result.average).toBeCloseTo((count + 1) / 2, 6);
    }
  });

  it('shows every percentile at exactly twenty', () => {
    const values = Array.from({ length: 20 }, (_, i) => i + 1);
    const result = distribution(values);

    expect(result.enough).toBe(true);
    expect(result.count).toBe(20);
    expect(result.median).toBeCloseTo(10.5, 6);
    expect(result.p25).toBeCloseTo(5.75, 6);
    expect(result.p75).toBeCloseTo(15.25, 6);
    expect(result.p10).toBeCloseTo(2.9, 6);
    expect(result.p90).toBeCloseTo(18.1, 6);
    expect(result.average).toBeCloseTo(10.5, 6);
  });

  /*
   * The same definition as Postgres `percentile_cont`, deliberately: a number
   * computed here and the same number computed in SQL must not disagree, because the
   * disagreement would look like a data bug rather than two definitions.
   */
  it('interpolates like percentile_cont', () => {
    const sorted = [1, 2, 3, 4];
    expect(percentile(sorted, 0)).toBe(1);
    expect(percentile(sorted, 0.5)).toBeCloseTo(2.5, 6);
    expect(percentile(sorted, 1)).toBe(4);
    expect(percentile(sorted, 0.25)).toBeCloseTo(1.75, 6);
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([7], 0.9)).toBe(7);
  });

  it('has an internal median that works below the display bar', () => {
    // The highlight rules split users into faster and slower than most, and that
    // split is meaningful long before twenty people. It never reaches a screen.
    expect(internalMedian([10, 20, 30])).toBe(20);
    expect(distribution([10, 20, 30]).median).toBeNull();
    expect(internalMedian([])).toBeNull();
  });

  it('calls a share of nothing null, not zero', () => {
    expect(rate(0, 0)).toBeNull();
    expect(rate(3, 4)).toBeCloseTo(0.75, 6);
  });
});

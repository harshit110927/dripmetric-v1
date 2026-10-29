import { describe, expect, it } from 'vitest';
import {
  classifyPricingView,
  pricingThresholds,
  quickExitRate,
  QUICK_EXIT_SESSION_END_SECONDS,
  SLOW_PAGE_MS,
  type PricingViewFact,
} from '../intent/pricing.js';
import { scoreAccount } from '../intent/accounts.js';
import {
  didntPayGroups,
  potentialRevenue,
  DEFAULT_DIDNT_PAY_WINDOW_DAYS,
} from '../intent/didnt-pay.js';
import { calibrate, MIN_PAYERS_FOR_CALIBRATION } from '../intent/calibration.js';
import {
  PRICING_ATTENTION_SECONDS,
  PRICING_VIEWS_FOR_OWN_THRESHOLD,
  type IntentSignalKey,
} from '../intent/points.js';

const NOW = new Date('2026-10-29T12:00:00Z');
const DAY = 86_400_000;

/** A first-ever pricing view that glanced and ended the session: the quick exit. */
function view(overrides: Partial<PricingViewFact> = {}): PricingViewFact {
  return {
    at: NOW,
    activeSeconds: 4,
    pageSpeedMs: 800,
    toggledInterval: false,
    clickedPlan: false,
    openedFaq: false,
    sessionEndedAfterSeconds: 30,
    previousViews: 0,
    previousViewAt: null,
    ...overrides,
  };
}

const DEFAULT_THRESHOLDS = pricingThresholds([]);

describe('the pricing patterns', () => {
  it('uses ten seconds until the product has fifty views of its own', () => {
    expect(DEFAULT_THRESHOLDS.attentionSeconds).toBe(PRICING_ATTENTION_SECONDS);
    expect(DEFAULT_THRESHOLDS.ownThreshold).toBe(false);

    const few = pricingThresholds(Array.from({ length: 49 }, () => 60));
    expect(few.attentionSeconds).toBe(PRICING_ATTENTION_SECONDS);

    /*
     * A product whose pricing page is read in a minute should not have its users
     * judged against ten seconds. At 50 views the bar becomes the product's own
     * 25th percentile (brief §8.2).
     */
    const many = pricingThresholds(
      Array.from({ length: PRICING_VIEWS_FOR_OWN_THRESHOLD }, (_, i) => i + 1),
    );
    expect(many.ownThreshold).toBe(true);
    expect(many.attentionSeconds).toBeCloseTo(13.25, 2);
  });

  it('calls a first-ever glance that ends the session a quick exit', () => {
    const reading = classifyPricingView(view(), DEFAULT_THRESHOLDS);
    expect(reading.pattern).toBe('quick-exit');
    expect(reading.countsAsLeak).toBe(true);
    expect(reading.deliberation).toBe(false);
    expect(reading.says).toContain('glanced');
  });

  /*
   * "The same exit, but the main content took over 4 seconds to appear | The page
   * failed, not the price." Blaming the price for a page that never appeared is the
   * most expensive mistake this rule could make.
   */
  it('blames the page, not the price, when the page was slow', () => {
    const reading = classifyPricingView(
      view({ pageSpeedMs: SLOW_PAGE_MS + 1_200 }),
      DEFAULT_THRESHOLDS,
    );
    expect(reading.pattern).toBe('slow-page');
    expect(reading.speedProblem).toBe(true);
    expect(reading.countsAsLeak).toBe(false);
    expect(reading.says).toContain('5.2 seconds');
    expect(reading.says).toContain('not a price problem');
  });

  it('never blames the page when the view was not a full load', () => {
    // Brief §8.2: "the speed check applies only to full page loads."
    const reading = classifyPricingView(view({ pageSpeedMs: null }), DEFAULT_THRESHOLDS);
    expect(reading.pattern).toBe('quick-exit');
    expect(reading.speedProblem).toBe(false);
  });

  it('is not a quick exit if the session carried on', () => {
    const reading = classifyPricingView(
      view({ sessionEndedAfterSeconds: QUICK_EXIT_SESSION_END_SECONDS + 60 }),
      DEFAULT_THRESHOLDS,
    );
    expect(reading.pattern).toBe('none');
    expect(reading.countsAsLeak).toBe(false);
  });

  it('is not a quick exit while the session is still open', () => {
    const reading = classifyPricingView(
      view({ sessionEndedAfterSeconds: null }),
      DEFAULT_THRESHOLDS,
    );
    // "Still open" is not "left quickly".
    expect(reading.pattern).toBe('none');
  });

  it('calls a toggle, a plan click or the FAQ deliberation, however brief', () => {
    for (const interaction of ['toggledInterval', 'clickedPlan', 'openedFaq'] as const) {
      const reading = classifyPricingView(
        view({ activeSeconds: 3, [interaction]: true }),
        DEFAULT_THRESHOLDS,
      );
      expect(reading.pattern, interaction).toBe('deliberation');
      expect(reading.deliberation).toBe(true);
      expect(reading.countsAsLeak).toBe(false);
    }
  });

  it('calls longer than the product’s median deliberation', () => {
    const thresholds = pricingThresholds([5, 10, 15, 20, 25]); // median 15
    const reading = classifyPricingView(view({ activeSeconds: 40 }), thresholds);
    expect(reading.pattern).toBe('deliberation');
    expect(reading.says).toContain('longer');
  });

  it('calls a proper second visit within a week deliberation', () => {
    const reading = classifyPricingView(
      view({
        activeSeconds: 12,
        previousViews: 1,
        previousViewAt: new Date(NOW.getTime() - 3 * DAY),
      }),
      DEFAULT_THRESHOLDS,
    );
    expect(reading.pattern).toBe('deliberation');
  });

  it('does not count a second visit outside the week', () => {
    const reading = classifyPricingView(
      view({
        activeSeconds: 12,
        previousViews: 1,
        previousViewAt: new Date(NOW.getTime() - 30 * DAY),
      }),
      DEFAULT_THRESHOLDS,
    );
    expect(reading.pattern).toBe('none');
  });

  it('calls a quick look by someone who has seen pricing before re-checking', () => {
    const reading = classifyPricingView(
      view({ activeSeconds: 3, previousViews: 2, previousViewAt: new Date(NOW.getTime() - DAY) }),
      DEFAULT_THRESHOLDS,
    );
    // "Already knows the price": neither an exit nor deliberation.
    expect(reading.pattern).toBe('re-checking');
    expect(reading.countsAsLeak).toBe(false);
    expect(reading.deliberation).toBe(false);
  });

  it('counts the quick exits in the rate', () => {
    const readings = [
      classifyPricingView(view(), DEFAULT_THRESHOLDS),
      classifyPricingView(view(), DEFAULT_THRESHOLDS),
      classifyPricingView(view({ clickedPlan: true }), DEFAULT_THRESHOLDS),
      classifyPricingView(view({ previousViews: 3 }), DEFAULT_THRESHOLDS),
    ];
    expect(quickExitRate(readings)).toBeCloseTo(0.5, 6);
    expect(quickExitRate([])).toBeNull();
  });
});

describe('account intent', () => {
  /*
   * Brief §8.2: "an account's score is its highest member's score, plus 10 when two
   * or more members were active that week."
   */
  it('takes the highest member, not the average', () => {
    const result = scoreAccount([
      { userKey: 1, score: 80, activeThisWeek: true },
      { userKey: 2, score: 5, activeThisWeek: false },
      { userKey: 3, score: 0, activeThisWeek: false },
    ]);

    expect(result.score).toBe(80);
    expect(result.topMemberKey).toBe(1);
    expect(result.teamBonus).toBe(0);
    expect(result.band).toBe('high');
    // Averaging would have hidden the one person deciding to buy.
    expect(result.score).not.toBe(Math.round((80 + 5 + 0) / 3));
  });

  it('adds ten when two or more were active this week', () => {
    const result = scoreAccount([
      { userKey: 1, score: 55, activeThisWeek: true },
      { userKey: 2, score: 20, activeThisWeek: true },
    ]);
    expect(result.teamBonus).toBe(10);
    expect(result.score).toBe(65);
    expect(result.band).toBe('high');
    expect(result.explanation).toContain('2 people');
  });

  it('does not add it for one active member', () => {
    const result = scoreAccount([
      { userKey: 1, score: 55, activeThisWeek: true },
      { userKey: 2, score: 20, activeThisWeek: false },
    ]);
    expect(result.teamBonus).toBe(0);
    expect(result.score).toBe(55);
  });

  it('still stops at a hundred', () => {
    const result = scoreAccount([
      { userKey: 1, score: 98, activeThisWeek: true },
      { userKey: 2, score: 70, activeThisWeek: true },
    ]);
    expect(result.score).toBe(100);
  });

  it('scores an empty account at zero', () => {
    expect(scoreAccount([]).score).toBe(0);
  });
});

describe('intent but didn’t pay', () => {
  const candidate = (overrides: Partial<Parameters<typeof didntPayGroups>[0][number]>) => ({
    userKey: 1,
    firstHighAt: new Date(NOW.getTime() - 20 * DAY),
    peakScore: 75,
    paidAt: null,
    ...overrides,
  });

  it('splits past the window from still inside it', () => {
    const groups = didntPayGroups(
      [
        candidate({ userKey: 1, firstHighAt: new Date(NOW.getTime() - 20 * DAY) }),
        candidate({ userKey: 2, firstHighAt: new Date(NOW.getTime() - 3 * DAY) }),
      ],
      NOW,
    );

    expect(groups.windowDays).toBe(DEFAULT_DIDNT_PAY_WINDOW_DAYS);
    expect(groups.pastWindow.map((c) => c.userKey)).toEqual([1]);
    expect(groups.insideWindow.map((c) => c.userKey)).toEqual([2]);
  });

  it('uses the project’s own window when it has one', () => {
    const groups = didntPayGroups(
      [candidate({ firstHighAt: new Date(NOW.getTime() - 20 * DAY) })],
      NOW,
      30,
    );
    expect(groups.pastWindow).toHaveLength(0);
    expect(groups.insideWindow).toHaveLength(1);
  });

  it('drops anyone who paid, whenever they paid', () => {
    const groups = didntPayGroups([candidate({ paidAt: NOW })], NOW);
    expect(groups.pastWindow).toHaveLength(0);
    expect(groups.insideWindow).toHaveLength(0);
  });

  it('never counts someone who did not reach sixty', () => {
    const groups = didntPayGroups(
      [candidate({ peakScore: 59, firstHighAt: null }), candidate({ peakScore: 40 })],
      NOW,
    );
    expect(groups.pastWindow).toHaveLength(0);
    expect(groups.insideWindow).toHaveLength(0);
  });

  it('never counts someone who asked to be deleted', () => {
    const groups = didntPayGroups([candidate({ excluded: true })], NOW);
    expect(groups.pastWindow).toHaveLength(0);
  });
});

describe('potential revenue', () => {
  it('shows its formula beside the number', () => {
    const revenue = potentialRevenue(7, 1_900, 'usd');
    expect(revenue).not.toBeNull();
    expect(revenue!.amountMinor).toBe(13_300);
    expect(revenue!.currency).toBe('usd');
    expect(revenue!.formula).toBe('7 users × 19.00 USD per month = 133.00 USD per month');
  });

  it('says "user" for one', () => {
    expect(potentialRevenue(1, 1_900, 'usd')!.formula).toContain('1 user ×');
  });

  it('refuses to invent a number with no confirmed price', () => {
    // A guessed price would be a made-up number on a screen whose whole promise is
    // that every number can be checked.
    expect(potentialRevenue(7, null, 'usd')).toBeNull();
    expect(potentialRevenue(7, 0, 'usd')).toBeNull();
  });

  it('keeps money in minor units', () => {
    const revenue = potentialRevenue(3, 2_999, 'eur', 'year');
    expect(revenue!.amountMinor).toBe(8_997);
    expect(Number.isInteger(revenue!.amountMinor)).toBe(true);
    expect(revenue!.formula).toContain('per year');
  });
});

describe('calibration', () => {
  function user(
    index: number,
    options: { paid: boolean; crossedBeforePaying?: boolean; signals?: IntentSignalKey[] },
  ) {
    const paidAt = options.paid ? new Date(NOW.getTime() - 5 * DAY) : null;
    const firstHighAt =
      options.crossedBeforePaying === false ? null : new Date(NOW.getTime() - 10 * DAY);
    return {
      userKey: index,
      peakScore: firstHighAt === null ? 40 : 75,
      firstHighAt,
      paidAt,
      signals: new Set<IntentSignalKey>(options.signals ?? []),
    };
  }

  it('says plainly when there are not enough payers to report anything', () => {
    const users = Array.from({ length: 20 }, (_, i) => user(i, { paid: i < 5 }));
    const result = calibrate(users, NOW);

    expect(result.ready).toBe(false);
    expect(result.payers).toBe(5);
    expect(result.lines.join('\n')).toContain(`5 of the ${MIN_PAYERS_FOR_CALIBRATION} needed`);
  });

  it('reports recall and precision once there are thirty payers', () => {
    const payers = Array.from({ length: 30 }, (_, i) =>
      user(i, { paid: true, crossedBeforePaying: i < 24 }),
    );
    const others = Array.from({ length: 70 }, (_, i) =>
      user(100 + i, { paid: false, crossedBeforePaying: i < 10 }),
    );
    const result = calibrate([...payers, ...others], NOW);

    expect(result.ready).toBe(true);
    expect(result.payers).toBe(30);
    // 24 of 30 payers crossed 60 before paying.
    expect(result.recall).toBeCloseTo(24 / 30, 6);
    // 34 users were ever above 60; 24 of them paid.
    expect(result.precision).toBeCloseTo(24 / 34, 6);

    const printed = result.lines.join('\n');
    expect(printed).toContain('recall');
    expect(printed).toContain('precision');
    expect(printed).toContain('80.0%');
  });

  it('does not credit a crossing that happened after the payment', () => {
    const late = {
      userKey: 1,
      peakScore: 90,
      firstHighAt: new Date(NOW.getTime() - DAY),
      paidAt: new Date(NOW.getTime() - 10 * DAY),
      signals: new Set<IntentSignalKey>(),
    };
    const result = calibrate([late], NOW);
    // The prediction was never made before the event it was meant to predict.
    expect(result.recall).toBe(0);
  });

  it('computes each signal’s lift and suggests a weight to approve', () => {
    // 'pricingViewed' is worth 10 points. Here everyone with it pays and nobody
    // without it does, which is a lift its points do not reflect.
    const withSignal = Array.from({ length: 20 }, (_, i) =>
      user(i, { paid: true, signals: ['pricingViewed'] }),
    );
    const withoutSignal = Array.from({ length: 40 }, (_, i) => user(100 + i, { paid: false }));

    const result = calibrate([...withSignal, ...withoutSignal], NOW);
    const lift = result.lifts.find((entry) => entry.key === 'pricingViewed')!;

    expect(lift.withRate).toBe(1);
    expect(lift.withoutRate).toBe(0);
    // Dividing by a zero rate is not a lift, so it is not reported as one.
    expect(lift.lift).toBeNull();
    expect(lift.withUsers).toBe(20);
  });

  it('suggests raising a cheap signal that converts twice as often', () => {
    const withSignal = Array.from({ length: 40 }, (_, i) =>
      user(i, { paid: i < 20, signals: ['pricingViewed'] }),
    ); // 50% convert
    const withoutSignal = Array.from({ length: 40 }, (_, i) => user(100 + i, { paid: i < 8 })); // 20%

    const result = calibrate([...withSignal, ...withoutSignal], NOW);
    const lift = result.lifts.find((entry) => entry.key === 'pricingViewed')!;

    expect(lift.lift).toBeCloseTo(2.5, 6);
    expect(lift.suggestion).not.toBeNull();
    expect(lift.suggestion!.suggestedPoints).toBe(20);
    expect(result.suggestions).toContainEqual(lift.suggestion!);
    // Never applied automatically (brief §8.2).
    expect(result.lines.join('\n')).toContain('never applied automatically');
  });

  it('reports no lift for a signal too few people have', () => {
    const users = [
      ...Array.from({ length: 3 }, (_, i) => user(i, { paid: true, signals: ['inviteSent'] })),
      ...Array.from({ length: 40 }, (_, i) => user(100 + i, { paid: false })),
    ];
    const lift = calibrate(users, NOW).lifts.find((entry) => entry.key === 'inviteSent')!;

    // A signal three people have would otherwise show a confident 12× lift.
    expect(lift.lift).toBeNull();
    expect(lift.suggestion).toBeNull();
  });
});

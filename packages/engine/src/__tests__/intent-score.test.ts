import { describe, expect, it } from 'vitest';
import {
  bandOf,
  BAND_HIGH_FROM,
  BAND_WARM_FROM,
  DECAY_HALF_LIFE_DAYS,
  FIT_POINTS_CAP,
  FIT_POINTS_EACH,
  FIT_POINT_KEYS,
  INTENT_POINTS,
  INTENT_SIGNAL_KEYS,
  MAX_SCORE,
  ZERO_POINT_EVIDENCE,
} from '../intent/points.js';
import { emptyFacts, replayPeak, scoreIntent, type IntentFacts } from '../intent/score.js';

/**
 * M7 exit checks (brief §11): "a fixture test for every row of the points table,
 * including the fit cap, the clamp at 0 and shared signals" and "a decay test".
 *
 * Brief §8.2: S_now = min(100, Σ p_i) × 2^(−d/7), clamped to 0–100.
 */

const NOW = new Date('2026-10-29T12:00:00Z');
const DAY = 86_400_000;

/** Someone who did exactly one thing, today. No decay, so points are visible. */
function facts(overrides: Partial<IntentFacts> = {}): IntentFacts {
  return { ...emptyFacts(), lastEventAt: NOW, ...overrides };
}

describe('every row of the points table', () => {
  /*
   * The table drives the test rather than the test restating the table.
   *
   * A hand-written list of expected points would be a second copy of the rule, and
   * the two copies would drift. What this asserts is that each row, on its own,
   * contributes exactly its own points and names itself.
   */
  it.each(INTENT_POINTS.filter((signal) => signal.key !== 'fitPoints'))(
    '$key is worth $points on its own',
    (signal) => {
      const result = scoreIntent(facts({ [signal.key]: true }), NOW);

      expect(result.rawPoints).toBe(signal.points);
      expect(result.score).toBe(Math.max(0, signal.points));
      expect(result.signals).toHaveLength(1);
      expect(result.signals[0]!.key).toBe(signal.key);
      expect(result.signals[0]!.points).toBe(signal.points);
      // Every point a founder sees can name the rule that produced it.
      expect(result.signals[0]!.rule.length).toBeGreaterThan(10);
      expect(result.signals[0]!.says.length).toBeGreaterThan(10);
    },
  );

  it('has a row for every signal key, and no more', () => {
    expect(INTENT_POINTS.map((signal) => signal.key).sort()).toEqual(
      [...INTENT_SIGNAL_KEYS].sort(),
    );
  });

  it('matches the brief’s numbers exactly', () => {
    // The one place the table is restated, so a silent edit to it fails here.
    const expected: Record<string, number> = {
      checkoutStarted: 30,
      activated: 25,
      planLimitOrPaywall: 20,
      pricingViewed: 10,
      pricingDeliberation: 10,
      inviteSent: 15,
      integrationOrImport: 10,
      coreActionEarly: 10,
      activeThreeOfSeven: 10,
      fastActivation: 10,
      paymentMethodBeforeTrialEnd: 15,
      salesContactRequested: 20,
      fitPoints: 5,
      disposableEmail: -20,
    };
    for (const signal of INTENT_POINTS) {
      expect(signal.points, signal.key).toBe(expected[signal.key]);
    }
  });

  it('adds the signals up', () => {
    const result = scoreIntent(
      facts({ checkoutStarted: true, activated: true, inviteSent: true }),
      NOW,
    );
    expect(result.rawPoints).toBe(30 + 25 + 15);
    expect(result.score).toBe(70);
    expect(result.band).toBe('high');
    // Biggest reason first, so the explanation leads with what matters.
    expect(result.signals[0]!.key).toBe('checkoutStarted');
  });
});

describe('shared signals', () => {
  /*
   * Brief §8.2: "Plan Limit Reached, or Upgrade Prompt Viewed at a paywall | +20 |
   * Counted once (shared)" and "Integration Connected or Data Imported | +10 | Once,
   * shared".
   *
   * One key per shared pair is how the sharing is enforced: there is no way to
   * express "both" in the facts, so a user who does both cannot be counted twice.
   */
  it('cannot count a shared pair twice, because it is one fact', () => {
    const limit = scoreIntent(facts({ planLimitOrPaywall: true }), NOW);
    expect(limit.rawPoints).toBe(20);

    const integration = scoreIntent(facts({ integrationOrImport: true }), NOW);
    expect(integration.rawPoints).toBe(10);

    // The keys the brief shares do not exist separately in the facts at all.
    expect(INTENT_SIGNAL_KEYS).toContain('planLimitOrPaywall');
    expect(INTENT_SIGNAL_KEYS).toContain('integrationOrImport');
    expect(INTENT_SIGNAL_KEYS).not.toContain('planLimitReached');
    expect(INTENT_SIGNAL_KEYS).not.toContain('dataImported');
  });
});

describe('the fit-point cap', () => {
  /*
   * Brief §8.2: "Fit points, total capped at 10 | +5 each". Five weakly predictive
   * facts about a person must not add up to most of the warm band on their own.
   */
  it('gives five for one and ten for two', () => {
    expect(scoreIntent(facts({ fit: { workEmail: true } }), NOW).rawPoints).toBe(5);
    expect(
      scoreIntent(facts({ fit: { workEmail: true, desktopAtSignup: true } }), NOW).rawPoints,
    ).toBe(10);
  });

  it('stops at ten however many are true', () => {
    const all = Object.fromEntries(FIT_POINT_KEYS.map((key) => [key, true]));
    const result = scoreIntent(facts({ fit: all }), NOW);

    expect(result.rawPoints).toBe(FIT_POINTS_CAP);
    expect(result.fit.points).toBe(FIT_POINTS_CAP);
    expect(result.fit.counted).toHaveLength(FIT_POINTS_CAP / FIT_POINTS_EACH);
    // And it says which were dropped, so the cap is visible rather than silent.
    expect(result.fit.dropped).toHaveLength(FIT_POINT_KEYS.length - result.fit.counted.length);
  });

  it('counts the same two for the same person every time', () => {
    const all = Object.fromEntries(FIT_POINT_KEYS.map((key) => [key, true]));
    const first = scoreIntent(facts({ fit: all }), NOW);
    const second = scoreIntent(facts({ fit: all }), NOW);
    expect(second.fit.counted).toEqual(first.fit.counted);
  });

  it('reports the fit points as one signal, not five', () => {
    const result = scoreIntent(facts({ fit: { workEmail: true, workingHoursSignup: true } }), NOW);
    expect(result.signals.filter((s) => s.key === 'fitPoints')).toHaveLength(1);
    expect(result.signals[0]!.points).toBe(10);
  });
});

describe('the clamps', () => {
  it('never goes below zero, however negative the signals', () => {
    const result = scoreIntent(facts({ disposableEmail: true }), NOW);
    expect(result.rawPoints).toBe(-20);
    expect(result.score).toBe(0);
    expect(result.band).toBe('low');
  });

  it('subtracts a throwaway address from real signals', () => {
    const result = scoreIntent(facts({ activated: true, disposableEmail: true }), NOW);
    expect(result.rawPoints).toBe(5);
    expect(result.score).toBe(5);
  });

  it('never goes above a hundred', () => {
    const everything = facts({
      checkoutStarted: true,
      activated: true,
      planLimitOrPaywall: true,
      pricingViewed: true,
      pricingDeliberation: true,
      inviteSent: true,
      integrationOrImport: true,
      coreActionEarly: true,
      activeThreeOfSeven: true,
      fastActivation: true,
      paymentMethodBeforeTrialEnd: true,
      salesContactRequested: true,
      fit: { workEmail: true, desktopAtSignup: true },
    });
    const result = scoreIntent(everything, NOW);

    // 30+25+20+10+10+15+10+10+10+10+15+20 signals, plus 10 capped fit points.
    expect(result.rawPoints).toBe(195);
    expect(result.basePoints).toBe(MAX_SCORE);
    expect(result.score).toBe(MAX_SCORE);
  });

  /*
   * The cap goes on BEFORE the decay, exactly as the brief writes it.
   *
   * Decaying first and capping after would leave someone with 185 points of signals
   * sitting at 100 for a fortnight: the decay would eat the surplus instead of the
   * score. Nobody's intent is twice as durable for having done everything twice.
   */
  it('caps before it decays, not after', () => {
    const everything = facts({
      checkoutStarted: true,
      activated: true,
      planLimitOrPaywall: true,
      inviteSent: true,
      salesContactRequested: true,
      lastEventAt: new Date(NOW.getTime() - 7 * DAY),
    });
    const result = scoreIntent(everything, NOW);

    expect(result.rawPoints).toBe(110);
    expect(result.basePoints).toBe(100);
    // One half-life: 100 → 50, not 110 → 55 → 55.
    expect(result.score).toBe(50);
  });

  it('scores someone who has never done anything at zero', () => {
    const result = scoreIntent(emptyFacts(), NOW);
    expect(result.score).toBe(0);
    expect(result.quietDays).toBeNull();
    expect(result.signals).toEqual([]);
    expect(result.explanation).toContain('Nothing they have done');
  });
});

describe('the decay', () => {
  /*
   * Brief §8.2: "intent halves after each quiet week", S_now = base × 2^(−d/7).
   */
  const base = facts({ checkoutStarted: true, activated: true, inviteSent: true }); // 70

  it('halves after each quiet week', () => {
    const at = (days: number) =>
      scoreIntent({ ...base, lastEventAt: new Date(NOW.getTime() - days * DAY) }, NOW).score;

    expect(at(0)).toBe(70);
    expect(at(7)).toBe(35);
    expect(at(14)).toBe(18); // 17.5, rounded
    expect(at(21)).toBe(9); // 8.75
    expect(at(28)).toBe(4);
  });

  it('moves someone out of the high band by going quiet', () => {
    const fresh = scoreIntent({ ...base, lastEventAt: NOW }, NOW);
    const stale = scoreIntent({ ...base, lastEventAt: new Date(NOW.getTime() - 7 * DAY) }, NOW);

    expect(fresh.band).toBe('high');
    expect(stale.band).toBe('warm');
    // And says why, in the number it shows.
    expect(stale.explanation).toContain('not been back for 7 days');
  });

  it('uses a seven-day half-life, as the brief says', () => {
    expect(DECAY_HALF_LIFE_DAYS).toBe(7);
    const half = scoreIntent(
      { ...base, lastEventAt: new Date(NOW.getTime() - DECAY_HALF_LIFE_DAYS * DAY) },
      NOW,
    );
    expect(half.decayFactor).toBeCloseTo(0.5, 10);
  });

  it('decays smoothly within a week, not in steps', () => {
    const half = scoreIntent({ ...base, lastEventAt: new Date(NOW.getTime() - 3.5 * DAY) }, NOW);
    expect(half.decayFactor).toBeCloseTo(Math.SQRT1_2, 10);
    expect(half.score).toBe(49); // 70 × 0.7071
  });

  it('does not decay for a future last event, which a skewed clock can produce', () => {
    const ahead = scoreIntent({ ...base, lastEventAt: new Date(NOW.getTime() + DAY) }, NOW);
    expect(ahead.quietDays).toBe(0);
    expect(ahead.score).toBe(70);
  });
});

describe('the bands', () => {
  it('splits low, warm and high exactly where the brief does', () => {
    expect(bandOf(0)).toBe('low');
    expect(bandOf(29)).toBe('low');
    expect(bandOf(BAND_WARM_FROM)).toBe('warm');
    expect(bandOf(59)).toBe('warm');
    expect(bandOf(BAND_HIGH_FROM)).toBe('high');
    expect(bandOf(100)).toBe('high');
  });
});

describe('the price-objection flag', () => {
  /*
   * Brief §8.2: three or more dismissals "sets a 'price objection' flag: a different
   * problem, not lower intent". So it must not move the score at all.
   */
  it('is carried without changing the score', () => {
    const without = scoreIntent(facts({ activated: true }), NOW);
    const with_ = scoreIntent(facts({ activated: true, priceObjection: true }), NOW);

    expect(with_.score).toBe(without.score);
    expect(with_.priceObjection).toBe(true);
    expect(without.priceObjection).toBe(false);
  });
});

describe('the peak, replayed from when each signal became true', () => {
  /*
   * Brief §8.2: "Keep two numbers per user: the current score … and the peak score."
   * The peak drives "intent but didn't pay", so it must not decay — a user who
   * reached 85 and went quiet has not become uninterested, they have become a leak.
   */
  const day = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * DAY);

  it('remembers the highest score they ever reached, and when', () => {
    const hot = facts({ checkoutStarted: true, activated: true, inviteSent: true });
    const peak = replayPeak(
      [
        { key: 'activated', at: day(40) },
        { key: 'inviteSent', at: day(35) },
        { key: 'checkoutStarted', at: day(30) },
      ],
      hot,
      60,
    );

    expect(peak.peakScore).toBe(70);
    expect(peak.peakAt).toEqual(day(30));

    // A month later their current score has decayed to almost nothing.
    expect(scoreIntent({ ...hot, lastEventAt: day(30) }, NOW).score).toBeLessThan(5);
    // The peak has not.
    expect(peak.peakScore).toBe(70);
  });

  it('finds the moment they crossed sixty, not the moment we noticed', () => {
    // 25 at activation, 45 with the plan limit, 60 with the invite: the crossing is
    // the invite, three weeks before anything else happened.
    const peak = replayPeak(
      [
        { key: 'activated', at: day(40) },
        { key: 'planLimitOrPaywall', at: day(38) },
        { key: 'inviteSent', at: day(30) },
        { key: 'pricingViewed', at: day(2) },
      ],
      facts({
        activated: true,
        planLimitOrPaywall: true,
        inviteSent: true,
        pricingViewed: true,
      }),
      60,
    );

    expect(peak.firstHighAt).toEqual(day(30));
    expect(peak.peakScore).toBe(70);
    expect(peak.peakAt).toEqual(day(2));
  });

  it('keeps the first crossing even when they go higher later', () => {
    const peak = replayPeak(
      [
        { key: 'checkoutStarted', at: day(20) },
        { key: 'activated', at: day(19) },
        { key: 'inviteSent', at: day(18) },
        { key: 'salesContactRequested', at: day(2) },
      ],
      facts({
        checkoutStarted: true,
        activated: true,
        inviteSent: true,
        salesContactRequested: true,
      }),
      60,
    );

    // 30 at checkout, 55 at activation, 70 at the invite: the crossing is the invite.
    expect(peak.firstHighAt).toEqual(day(18));
    expect(peak.peakScore).toBe(90);
  });

  it('leaves the crossing null for someone who never got there', () => {
    const peak = replayPeak([{ key: 'activated', at: day(10) }], facts({ activated: true }), 60);
    expect(peak.firstHighAt).toBeNull();
    expect(peak.peakScore).toBe(25);
  });

  it('starts from the fit points, which are true before anything happens', () => {
    const peak = replayPeak(
      [{ key: 'activated', at: day(10) }],
      facts({ activated: true, fit: { workEmail: true, workingHoursSignup: true } }),
      60,
    );
    // 10 of fit points plus 25 for activating.
    expect(peak.peakScore).toBe(35);
  });

  it('is the same answer however often it is replayed', () => {
    const moments = [
      { key: 'activated' as const, at: day(40) },
      { key: 'inviteSent' as const, at: day(35) },
      { key: 'checkoutStarted' as const, at: day(30) },
    ];
    const userFacts = facts({ checkoutStarted: true, activated: true, inviteSent: true });

    const first = replayPeak(moments, userFacts, 60);
    const second = replayPeak([...moments].reverse(), userFacts, 60);
    // The order it is handed the moments cannot change the answer.
    expect(second).toEqual(first);
  });
});

describe('the signals that carry no points yet', () => {
  /*
   * Brief §8.2: "Signals in Appendix A that have no value in this table … are stored
   * as evidence and add 0 points until calibration. Do not invent points."
   */
  it('lists them, so the omission is deliberate rather than an oversight', () => {
    expect(ZERO_POINT_EVIDENCE.length).toBeGreaterThan(4);
    // None of them is a scoring signal.
    for (const name of ZERO_POINT_EVIDENCE) {
      expect(INTENT_SIGNAL_KEYS).not.toContain(name);
    }
  });
});

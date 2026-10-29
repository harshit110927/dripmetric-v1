import { describe, expect, it } from 'vitest';
import {
  cancelledOrFailed,
  highIntentQuiet,
  LAST_MOMENT_HOURS,
  lastMomentDrop,
  limitReachedNoUpgrade,
  LIMIT_UPGRADE_DAYS,
  onboardingStalls,
  payerGoingQuiet,
  pricingQuickExit,
  stepCollapse,
  trialEndedUnpaid,
  userLeaks,
  USER_LEAK_TYPES,
  WENT_QUIET_DAYS,
  type StepLeakFact,
  type UserLeakFacts,
} from '../leaks/rules.js';
import {
  collapseTest,
  poissonCdf,
  COLLAPSE_MIN_EXPECTED,
  COLLAPSE_P_THRESHOLD,
} from '../leaks/poisson.js';
import { LEAK_DEFINITIONS, LEAK_TYPES, unavailableLeaks, type LeakType } from '../leaks/types.js';

/**
 * M8 exit checks (brief §11):
 *
 *   "fixtures with time travel for every leak"
 *   "each fires exactly once per episode; a returning user resets it"
 *   "none fires for a paid, deleted or opted-out user"
 *   "the collapse test fires only when ≥ 10 completions were expected and p < 0.01"
 *   "a leak lacking the paid event or trial dates shows as off, with its reason"
 *
 * Time travel here means calling the rule with different `now` values over the same
 * facts, which is possible precisely because every rule takes `now` as a parameter
 * (CLAUDE.md rule 9).
 */

const T0 = new Date('2026-10-01T09:00:00Z');
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** `now`, a given number of hours after t0. */
const at = (hours: number) => new Date(T0.getTime() + hours * HOUR);
const days = (count: number) => new Date(T0.getTime() + count * DAY);

function step(overrides: Partial<StepLeakFact> = {}): StepLeakFact {
  return {
    stepId: 2,
    label: 'Connect a bank',
    importance: 'key',
    enteredAt: T0,
    completedAt: null,
    lastEventAt: T0,
    // The 24-hour default, in seconds.
    stallSeconds: 24 * 3_600,
    completions: 3,
    ...overrides,
  };
}

function facts(overrides: Partial<UserLeakFacts> = {}): UserLeakFacts {
  return {
    userKey: 7,
    paidAt: null,
    deletedAt: null,
    optedOut: false,
    lastEventAt: T0,
    peakScore: 0,
    firstHighAt: null,
    trialEndsAt: null,
    checkoutStartedAt: null,
    planLimitReachedAt: null,
    cancelledAt: null,
    cancelReason: null,
    paymentFailedAt: null,
    paymentFailedCode: null,
    steps: [],
    pricingQuickExitAt: null,
    recentWeeklyActiveDays: null,
    baselineActiveDaysPerWeek: null,
    ...overrides,
  };
}

describe('onboarding stall', () => {
  /*
   * The brief's own worked example: "enters step 2 at t0, no event for 49 hours:
   * exactly one stall".
   */
  it('fires exactly once for 49 hours of silence after entering a step', () => {
    const user = facts({ steps: [step()] });

    expect(onboardingStalls(user, at(23))).toEqual([]);
    const atFire = onboardingStalls(user, at(25));
    expect(atFire).toHaveLength(1);
    expect(atFire[0]!.type).toBe('onboarding-stall');

    const later = onboardingStalls(user, at(49));
    expect(later).toHaveLength(1);
    // Same episode, 24 hours apart: the same key, so storing it twice is impossible.
    expect(later[0]!.episodeKey).toBe(atFire[0]!.episodeKey);
    // And `firedAt` is when the leak became true, not when the sweep noticed.
    expect(later[0]!.firedAt).toEqual(atFire[0]!.firedAt);
    expect(later[0]!.firedAt).toEqual(at(24));
  });

  it('resets when the user comes back and stalls again', () => {
    const first = onboardingStalls(facts({ steps: [step()] }), at(30));
    // They did something at hour 30, then went quiet again.
    const second = onboardingStalls(facts({ steps: [step({ lastEventAt: at(30) })] }), at(60));

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    // A different episode, so a second alert is allowed (brief §8.3).
    expect(second[0]!.episodeKey).not.toBe(first[0]!.episodeKey);
  });

  it('stops once they finish the step', () => {
    const user = facts({ steps: [step({ completedAt: at(40) })] });
    expect(onboardingStalls(user, at(60))).toEqual([]);
  });

  it('never fires for a step they never entered', () => {
    const user = facts({ steps: [step({ enteredAt: null, lastEventAt: null })] });
    expect(onboardingStalls(user, at(100))).toEqual([]);
  });

  /*
   * "Once a step has 20 completions, use that step's 90th-percentile elapsed time,
   * clamped to 1 to 72 hours." The bar is adaptive, and the sentence says which bar
   * it used.
   */
  it('uses the step’s own bar once 20 people have finished it, and says so', () => {
    const adaptive = facts({
      steps: [step({ stallSeconds: 4 * 3_600, completions: 44 })],
    });

    expect(onboardingStalls(adaptive, at(3))).toEqual([]);
    const found = onboardingStalls(adaptive, at(5));
    expect(found).toHaveLength(1);
    expect(found[0]!.says).toContain('Nine in ten people');
    expect(found[0]!.details['bar']).toBe('the step’s own slowest tenth');

    // Below 20 completions it is the default, and it does not claim a percentile.
    const defaulted = onboardingStalls(facts({ steps: [step()] }), at(25));
    expect(defaulted[0]!.says).not.toContain('Nine in ten');
    expect(defaulted[0]!.details['bar']).toBe('the 24-hour default');
  });

  it('fires per step, not per person', () => {
    const user = facts({
      steps: [
        step({ stepId: 2, label: 'Connect a bank' }),
        step({ stepId: 3, label: 'Send first invoice' }),
      ],
    });
    const found = onboardingStalls(user, at(30));
    expect(found).toHaveLength(2);
    expect(new Set(found.map((f) => f.episodeKey)).size).toBe(2);
  });
});

describe('last-moment drop', () => {
  it('fires two hours after a checkout with no payment', () => {
    const user = facts({ checkoutStartedAt: T0 });

    expect(lastMomentDrop(user, at(LAST_MOMENT_HOURS - 0.5))).toBeNull();
    const found = lastMomentDrop(user, at(LAST_MOMENT_HOURS + 0.5));
    expect(found).not.toBeNull();
    expect(found!.firedAt).toEqual(at(LAST_MOMENT_HOURS));
  });

  it('never fires once they paid', () => {
    const user = facts({ checkoutStartedAt: T0, paidAt: at(1) });
    expect(lastMomentDrop(user, at(10))).toBeNull();
  });

  it('treats a second checkout as a second episode', () => {
    const first = lastMomentDrop(facts({ checkoutStartedAt: T0 }), at(5))!;
    const second = lastMomentDrop(facts({ checkoutStartedAt: at(20) }), at(30))!;
    expect(second.episodeKey).not.toBe(first.episodeKey);
  });
});

describe('high-intent user went quiet', () => {
  const hot = facts({
    peakScore: 78,
    firstHighAt: T0,
    lastEventAt: at(1),
  });

  it('fires seven days after their last event', () => {
    expect(highIntentQuiet(hot, days(6))).toBeNull();
    const found = highIntentQuiet(hot, days(8));
    expect(found).not.toBeNull();
    expect(found!.says).toContain('78 out of 100');
    expect(found!.firedAt).toEqual(new Date(at(1).getTime() + WENT_QUIET_DAYS * DAY));
  });

  it('never fires below sixty', () => {
    expect(highIntentQuiet({ ...hot, peakScore: 59, firstHighAt: null }, days(30))).toBeNull();
  });

  it('never fires for someone who paid', () => {
    expect(highIntentQuiet({ ...hot, paidAt: days(2) }, days(30))).toBeNull();
  });

  it('resets when they come back and go quiet again', () => {
    const first = highIntentQuiet(hot, days(8))!;
    const second = highIntentQuiet({ ...hot, lastEventAt: days(10) }, days(20))!;
    expect(second.episodeKey).not.toBe(first.episodeKey);
  });
});

describe('trial ended unpaid', () => {
  it('fires on the day the trial ends and not before', () => {
    const user = facts({ trialEndsAt: days(14) });
    expect(trialEndedUnpaid(user, days(13))).toBeNull();

    const found = trialEndedUnpaid(user, days(14.5));
    expect(found).not.toBeNull();
    expect(found!.says).toContain('trial ended on');
    expect(found!.firedAt).toEqual(days(14));
  });

  it('fires once however often the sweep runs', () => {
    const user = facts({ trialEndsAt: days(14) });
    const keys = [days(15), days(16), days(40)].map(
      (now) => trialEndedUnpaid(user, now)!.episodeKey,
    );
    expect(new Set(keys).size).toBe(1);
  });

  it('treats an extended trial as a new episode', () => {
    const first = trialEndedUnpaid(facts({ trialEndsAt: days(14) }), days(15))!;
    const extended = trialEndedUnpaid(facts({ trialEndsAt: days(28) }), days(30))!;
    expect(extended.episodeKey).not.toBe(first.episodeKey);
  });

  it('never fires for someone who paid', () => {
    expect(
      trialEndedUnpaid(facts({ trialEndsAt: days(14), paidAt: days(10) }), days(20)),
    ).toBeNull();
  });
});

describe('limit reached without upgrading', () => {
  it('fires seven days after the limit, not before', () => {
    const user = facts({ planLimitReachedAt: T0 });
    expect(limitReachedNoUpgrade(user, days(6))).toBeNull();
    expect(limitReachedNoUpgrade(user, days(LIMIT_UPGRADE_DAYS + 1))).not.toBeNull();
  });

  it('never fires if they upgraded', () => {
    const user = facts({ planLimitReachedAt: T0, paidAt: days(2) });
    expect(limitReachedNoUpgrade(user, days(30))).toBeNull();
  });
});

describe('cancelled or payment failed', () => {
  it('fires for a cancellation, with the stated reason', () => {
    const found = cancelledOrFailed(
      facts({ paidAt: days(-30), cancelledAt: days(1), cancelReason: 'too expensive' }),
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.says).toContain('too expensive');
  });

  it('fires for a failed payment as its own episode', () => {
    const found = cancelledOrFailed(
      facts({
        paidAt: days(-30),
        cancelledAt: days(1),
        paymentFailedAt: days(2),
        paymentFailedCode: 'insufficient_funds',
      }),
    );
    expect(found).toHaveLength(2);
    expect(new Set(found.map((f) => f.episodeKey)).size).toBe(2);
  });

  /*
   * This leak is ABOUT paying customers, so having paid cannot silence it — but
   * being deleted or opted out still does.
   */
  it('is not silenced by having paid, but is by a deletion or an opt-out', () => {
    const base = facts({ paidAt: days(-30), cancelledAt: days(1) });
    expect(cancelledOrFailed(base)).toHaveLength(1);
    expect(cancelledOrFailed({ ...base, deletedAt: days(2) })).toEqual([]);
    expect(cancelledOrFailed({ ...base, optedOut: true })).toEqual([]);
  });
});

describe('payer going quiet', () => {
  const payer = facts({
    paidAt: days(-60),
    baselineActiveDaysPerWeek: 5,
    recentWeeklyActiveDays: [1, 2],
  });

  it('fires when two weeks running are at or below half their own baseline', () => {
    const found = payerGoingQuiet(payer, days(30));
    expect(found).not.toBeNull();
    expect(found!.says).toContain('5.0 days a week');
    expect(found!.details['bar']).toBe(2.5);
  });

  it('does not fire when only one week dipped', () => {
    expect(payerGoingQuiet({ ...payer, recentWeeklyActiveDays: [1, 4] }, days(30))).toBeNull();
  });

  /*
   * "Against their own 4-week baseline" is the point: a customer who logs in twice a
   * week has not gone quiet by logging in twice a week.
   */
  it('judges against their own baseline, not a global one', () => {
    const lightUser = {
      ...payer,
      baselineActiveDaysPerWeek: 2,
      recentWeeklyActiveDays: [2, 2] as [number, number],
    };
    expect(payerGoingQuiet(lightUser, days(30))).toBeNull();
  });

  it('does not fire for someone who never paid', () => {
    expect(payerGoingQuiet({ ...payer, paidAt: null }, days(30))).toBeNull();
  });

  it('does not turn a baseline of almost nothing into a story', () => {
    const barely = {
      ...payer,
      baselineActiveDaysPerWeek: 0.5,
      recentWeeklyActiveDays: [0, 0] as [number, number],
    };
    expect(payerGoingQuiet(barely, days(30))).toBeNull();
  });
});

describe('pricing quick exit', () => {
  it('records the instance, for the rate and the timeline', () => {
    const found = pricingQuickExit(facts({ pricingQuickExitAt: T0 }));
    expect(found).not.toBeNull();
    expect(found!.type).toBe('pricing-quick-exit');
  });

  it('is silent for someone who paid, was deleted or opted out', () => {
    for (const override of [{ paidAt: T0 }, { deletedAt: T0 }, { optedOut: true }]) {
      expect(pricingQuickExit(facts({ pricingQuickExitAt: T0, ...override }))).toBeNull();
    }
  });
});

describe('the guards, on every per-person leak', () => {
  /*
   * M8 exit check: "none fires for a paid, deleted or opted-out user."
   *
   * Driven over every leak `userLeaks` can produce, so a new leak that forgets the
   * guard fails here rather than in production.
   */
  const everything = facts({
    lastEventAt: T0,
    peakScore: 90,
    firstHighAt: T0,
    trialEndsAt: days(1),
    checkoutStartedAt: T0,
    planLimitReachedAt: T0,
    cancelledAt: days(1),
    paymentFailedAt: days(1),
    pricingQuickExitAt: T0,
    steps: [step()],
    baselineActiveDaysPerWeek: 5,
    recentWeeklyActiveDays: [0, 0],
  });

  it('produces every per-person leak for someone with nothing in their way', () => {
    const found = userLeaks({ ...everything, paidAt: days(-60) }, days(30));
    // The paid guard silences the four that need them unpaid, and allows the rest.
    expect(found.map((f) => f.type)).toContain('cancelled-or-failed');
    expect(found.map((f) => f.type)).toContain('payer-going-quiet');

    const unpaid = userLeaks(everything, days(30));
    const types = new Set(unpaid.map((f) => f.type));
    for (const type of [
      'onboarding-stall',
      'last-moment-drop',
      'high-intent-quiet',
      'trial-ended-unpaid',
      'limit-reached-no-upgrade',
      'pricing-quick-exit',
      'cancelled-or-failed',
    ] satisfies LeakType[]) {
      expect(types, type).toContain(type);
    }
  });

  it('says nothing at all about someone who asked to be deleted', () => {
    expect(userLeaks({ ...everything, deletedAt: days(2) }, days(30))).toEqual([]);
  });

  it('says nothing at all about someone who opted out', () => {
    expect(userLeaks({ ...everything, optedOut: true }, days(30))).toEqual([]);
  });

  it('says nothing about a payer except the leaks that are about payers', () => {
    const found = userLeaks({ ...everything, paidAt: days(-60) }, days(30));
    const types = new Set(found.map((f) => f.type));

    expect(types).toEqual(new Set(['cancelled-or-failed', 'payer-going-quiet']));
    // The four that need "never paid" are all silent.
    for (const type of [
      'last-moment-drop',
      'high-intent-quiet',
      'trial-ended-unpaid',
      'limit-reached-no-upgrade',
    ] satisfies LeakType[]) {
      expect(types, type).not.toContain(type);
    }
  });

  it('covers every per-person leak type in the list', () => {
    // So a tenth leak cannot be added without being guarded and tested.
    const perPerson = LEAK_DEFINITIONS.filter((d) => d.subject === 'user').map((d) => d.type);
    expect([...USER_LEAK_TYPES].sort()).toEqual([...perPerson].sort());
  });
});

describe('the step-completion collapse', () => {
  /*
   * M8 exit check: "the collapse test fires only when ≥ 10 completions were expected
   * and p < 0.01."
   */
  it('matches a known Poisson value', () => {
    // P(X ≤ 0 | λ=1) = e^-1.
    expect(poissonCdf(0, 1)).toBeCloseTo(Math.exp(-1), 10);
    // P(X ≤ 2 | λ=2) = e^-2 (1 + 2 + 2) = 5 e^-2.
    expect(poissonCdf(2, 2)).toBeCloseTo(5 * Math.exp(-2), 10);
    expect(poissonCdf(-1, 3)).toBe(0);
    expect(poissonCdf(100, 0)).toBe(1);
  });

  it('stays finite for a busy step, where the naive formula overflows', () => {
    // λ in the hundreds is exactly the step whose collapse matters most, and
    // `Math.pow(λ, i) / i!` is Infinity/NaN there.
    const p = poissonCdf(100, 400);
    expect(Number.isFinite(p)).toBe(true);
    expect(p).toBeGreaterThanOrEqual(0);
    expect(p).toBeLessThan(0.001);
  });

  it('refuses to fire when too few completions were expected', () => {
    // A step that normally gets 2 a day and got none: p is low-ish, volume is not.
    const quiet = collapseTest(0, 2 * 14);
    expect(quiet.expected).toBeCloseTo(2, 6);
    expect(quiet.expected).toBeLessThan(COLLAPSE_MIN_EXPECTED);
    expect(quiet.collapsed).toBe(false);
    expect(quiet.because).toContain(`at least ${COLLAPSE_MIN_EXPECTED}`);
  });

  it('refuses to fire on normal variation', () => {
    // 40 a day, saw 35.
    const normal = collapseTest(35, 40 * 14);
    expect(normal.p).toBeGreaterThan(COLLAPSE_P_THRESHOLD);
    expect(normal.collapsed).toBe(false);
    expect(normal.because).toContain('normal variation');
  });

  it('fires when a busy step falls off a cliff', () => {
    // 40 a day, saw 6.
    const broken = collapseTest(6, 40 * 14);
    expect(broken.expected).toBeCloseTo(40, 6);
    expect(broken.p).toBeLessThan(COLLAPSE_P_THRESHOLD);
    expect(broken.collapsed).toBe(true);
    expect(broken.because).toBeNull();
  });

  it('tells the same halving apart on a quiet step and a busy one', () => {
    // The whole reason for a Poisson test rather than a percentage drop.
    expect(collapseTest(6, 12 * 14).collapsed).toBe(false);
    expect(collapseTest(600, 1_200 * 14).collapsed).toBe(true);
  });

  it('produces an unmasked finding about a step', () => {
    const found = stepCollapse(
      { stepId: 3, label: 'Send first invoice', observed: 4, baselineCompletions: 40 * 14 },
      days(2),
    );
    expect(found).not.toBeNull();
    expect(found!.subject).toBe('step');
    expect(found!.subjectKey).toBe(3);
    expect(found!.says).toContain('Send first invoice');
    expect(found!.says).toContain('probably broken');
  });

  it('fires once a day while a collapse persists', () => {
    const fact = { stepId: 3, label: 'A step', observed: 0, baselineCompletions: 40 * 14 };
    const morning = stepCollapse(fact, new Date('2026-10-03T08:00:00Z'))!;
    const evening = stepCollapse(fact, new Date('2026-10-03T20:00:00Z'))!;
    const tomorrow = stepCollapse(fact, new Date('2026-10-04T08:00:00Z'))!;

    // The hourly sweep cannot fire the same collapse twice in a day …
    expect(evening.episodeKey).toBe(morning.episodeKey);
    // … and a second day of it is worth hearing about.
    expect(tomorrow.episodeKey).not.toBe(morning.episodeKey);
  });
});

describe('leaks that cannot run yet', () => {
  /*
   * M8 exit check: "a leak lacking the paid event or trial dates shows as off, with
   * its reason."
   */
  it('turns off the four that need a paid event, and says why', () => {
    const off = unavailableLeaks({ paidEvent: false, trialDates: true, price: true });
    expect(off.map((entry) => entry.type).sort()).toEqual([
      'high-intent-quiet',
      'last-moment-drop',
      'limit-reached-no-upgrade',
      'payer-going-quiet',
      'trial-ended-unpaid',
    ]);
    for (const entry of off) {
      expect(entry.because).toContain('Subscription Started');
    }
  });

  it('turns off trial-ended-unpaid when the trial dates are missing', () => {
    const off = unavailableLeaks({ paidEvent: true, trialDates: false, price: true });
    expect(off.map((entry) => entry.type)).toEqual(['trial-ended-unpaid']);
    expect(off[0]!.because).toContain('trialEndsAt');
  });

  it('turns nothing off when everything is there', () => {
    expect(unavailableLeaks({ paidEvent: true, trialDates: true, price: true })).toEqual([]);
  });

  it('has a definition for all nine leaks, with a rule a founder can read', () => {
    expect(LEAK_DEFINITIONS).toHaveLength(LEAK_TYPES.length);
    for (const definition of LEAK_DEFINITIONS) {
      expect(definition.rule.length, definition.type).toBeGreaterThan(30);
      expect(definition.rule.endsWith('.'), definition.type).toBe(true);
    }
    // The collapse is the one unmasked leak: it is about a step, not a person.
    const unmasked = LEAK_DEFINITIONS.filter((d) => !d.masked).map((d) => d.type);
    expect(unmasked).toEqual(['step-collapse']);
  });
});

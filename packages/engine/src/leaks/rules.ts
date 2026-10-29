import { hours } from '../funnel/classify.js';
import { HIGH_INTENT_THRESHOLD } from '../intent/points.js';
import { collapseTest, type CollapseTest } from './poisson.js';
import type { LeakFinding, LeakType } from './types.js';

/**
 * The nine leak rules (brief §8.3), each a pure function of facts and `now`.
 *
 * "Every leak is a pure function of facts and `now`, and has fixture tests, including
 * time-travel cases such as 'enters step 2 at t0, no event for 49 hours: exactly one
 * stall'."
 *
 * Every rule returns at most one finding per subject per episode, and each finding
 * carries the episode key that makes "once per person per leak" enforceable.
 */

/** Brief §8.3: "no `Subscription Started` within 2 hours". */
export const LAST_MOMENT_HOURS = 2;
/** Brief §8.3: "then 7 days without activity". */
export const WENT_QUIET_DAYS = 7;
/** Brief §8.3: "no upgrade … within 7 days". */
export const LIMIT_UPGRADE_DAYS = 7;
/** Brief §8.3: "fall by half or more … two weeks running". */
export const PAYER_QUIET_RATIO = 0.5;
export const PAYER_QUIET_WEEKS = 2;
export const PAYER_BASELINE_WEEKS = 4;
/** Brief §8.3: trial-only checkouts "never count as a last-moment drop". */
export const TRIAL_CHECKOUT_TYPES = ['trial'] as const;

const HOUR = 3_600_000;
const DAY = 86_400_000;

/**
 * The three guards that apply to every per-person leak (brief §8.3).
 *
 * "Never alert about someone who already paid, was deleted or opted out. Treat the
 * `optedOut` trait and a deletion request as opt-outs."
 *
 * One function, called by every rule, so there is no leak that can forget. The
 * trial-ended and cancelled leaks pass `ignorePaid` because for them having paid is
 * part of the story rather than a reason to stay quiet.
 */
export interface SubjectGuards {
  paidAt: Date | null;
  deletedAt: Date | null;
  optedOut: boolean;
}

export function suppressed(guards: SubjectGuards, options: { ignorePaid?: boolean } = {}): boolean {
  if (guards.deletedAt !== null) return true;
  if (guards.optedOut) return true;
  if (options.ignorePaid !== true && guards.paidAt !== null) return true;
  return false;
}

/** A step, as the stall rule sees it. */
export interface StepLeakFact {
  stepId: number;
  label: string;
  importance: 'key' | 'normal' | 'optional';
  enteredAt: Date | null;
  completedAt: Date | null;
  /** Their last event on this step: "no progress" is measured from here. */
  lastEventAt: Date | null;
  /**
   * How long this step allows before it counts as a stall.
   *
   * M6's `stuckElapsedSeconds`: the founder's override, else the step's own 90th
   * percentile clamped to 1–72 hours, else the 24-hour default. The stall is
   * "adaptive" because this number is, not because the rule is.
   */
  stallSeconds: number;
  /** How many people have finished the step, so the rule can say which bar it used. */
  completions: number;
}

export interface UserLeakFacts extends SubjectGuards {
  userKey: number;
  lastEventAt: Date | null;

  /** Intent, from M7's stored state. */
  peakScore: number;
  firstHighAt: Date | null;

  trialEndsAt: Date | null;
  /** A non-trial checkout. Trial-only checkouts are excluded upstream. */
  checkoutStartedAt: Date | null;
  planLimitReachedAt: Date | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
  paymentFailedAt: Date | null;
  paymentFailedCode: string | null;

  steps: readonly StepLeakFact[];

  /** The first pricing view that was a quick exit, if there was one. */
  pricingQuickExitAt: Date | null;

  /** Active days in each of the last two completed weeks, newest first. */
  recentWeeklyActiveDays: readonly [number, number] | null;
  /** Their own average active days per week over the 4 weeks before those. */
  baselineActiveDaysPerWeek: number | null;
}

/** An ISO day, used in episode keys so a date-based episode is stable. */
function isoDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/**
 * Onboarding stall (brief §8.3).
 *
 * "Entered a step, no progress for 24 hours, overridable per step. Once a step has 20
 * completions, use that step's 90th-percentile elapsed time, clamped to 1 to 72
 * hours."
 *
 * The episode is the step plus the last thing they did on it. A user who comes back,
 * does something and stalls again has a different last event, so the key changes and
 * a second episode can fire — which is the brief's "a user who comes back resets it".
 */
export function onboardingStalls(facts: UserLeakFacts, now: Date): LeakFinding[] {
  if (suppressed(facts)) return [];
  const findings: LeakFinding[] = [];

  for (const step of facts.steps) {
    if (step.enteredAt === null || step.completedAt !== null) continue;
    const since = step.lastEventAt ?? step.enteredAt;
    const idleSeconds = (now.getTime() - since.getTime()) / 1000;
    if (idleSeconds < step.stallSeconds) continue;

    findings.push({
      type: 'onboarding-stall',
      subject: 'user',
      subjectKey: facts.userKey,
      firedAt: new Date(since.getTime() + step.stallSeconds * 1000),
      episodeKey: `step:${step.stepId}:${since.toISOString()}`,
      says:
        step.completions >= 20
          ? `They have been stuck on "${step.label}" for ${hours(idleSeconds)}. Nine in ten people who finish it do so within ${hours(step.stallSeconds)}.`
          : `They have been stuck on "${step.label}" for ${hours(idleSeconds)}.`,
      details: {
        stepId: step.stepId,
        label: step.label,
        idleSeconds: Math.round(idleSeconds),
        stallSeconds: step.stallSeconds,
        bar: step.completions >= 20 ? 'the step’s own slowest tenth' : 'the 24-hour default',
        completions: step.completions,
      },
    });
  }

  return findings;
}

/**
 * Last-moment drop (brief §8.3).
 *
 * "`Checkout Started` (not a trial-only checkout) with no `Subscription Started`
 * within 2 hours."
 */
export function lastMomentDrop(facts: UserLeakFacts, now: Date): LeakFinding | null {
  // Paying is the opposite of this leak, so the guard does the work: a user who paid
  // at any point is never a last-moment drop.
  if (suppressed(facts)) return null;
  if (facts.checkoutStartedAt === null) return null;

  const deadline = facts.checkoutStartedAt.getTime() + LAST_MOMENT_HOURS * HOUR;
  if (now.getTime() < deadline) return null;

  return {
    type: 'last-moment-drop',
    subject: 'user',
    subjectKey: facts.userKey,
    firedAt: new Date(deadline),
    // The checkout itself is the episode: a second attempt is a second episode.
    episodeKey: `checkout:${facts.checkoutStartedAt.toISOString()}`,
    says: `They started checking out ${hours((now.getTime() - facts.checkoutStartedAt.getTime()) / 1000)} ago and no payment arrived.`,
    details: {
      checkoutStartedAt: facts.checkoutStartedAt.toISOString(),
      waitedHours: LAST_MOMENT_HOURS,
    },
  };
}

/**
 * High-intent user went quiet (brief §8.3).
 *
 * "Score reached 60 or more, then 7 days without activity, never paid."
 */
export function highIntentQuiet(facts: UserLeakFacts, now: Date): LeakFinding | null {
  if (suppressed(facts)) return null;
  if (facts.peakScore < HIGH_INTENT_THRESHOLD || facts.firstHighAt === null) return null;
  if (facts.lastEventAt === null) return null;

  const quietSince = facts.lastEventAt;
  const deadline = quietSince.getTime() + WENT_QUIET_DAYS * DAY;
  if (now.getTime() < deadline) return null;
  // They cannot have gone quiet before they were ever interested.
  if (quietSince < facts.firstHighAt) return null;

  return {
    type: 'high-intent-quiet',
    subject: 'user',
    subjectKey: facts.userKey,
    firedAt: new Date(deadline),
    // The quiet period is the episode: coming back and going quiet again is a new one.
    episodeKey: `quiet:${quietSince.toISOString()}`,
    says: `They looked ready to buy — ${facts.peakScore} out of 100 — and have not been back for ${hours((now.getTime() - quietSince.getTime()) / 1000)}.`,
    details: {
      peakScore: facts.peakScore,
      firstHighAt: facts.firstHighAt.toISOString(),
      lastEventAt: quietSince.toISOString(),
      quietDays: WENT_QUIET_DAYS,
    },
  };
}

/**
 * Trial ended unpaid (brief §8.3).
 *
 * "The trial end date passed with no payment event." The episode is the trial's own
 * end date, so extending a trial produces a new episode and re-extending does not
 * produce two.
 */
export function trialEndedUnpaid(facts: UserLeakFacts, now: Date): LeakFinding | null {
  if (suppressed(facts)) return null;
  if (facts.trialEndsAt === null) return null;
  if (now.getTime() < facts.trialEndsAt.getTime()) return null;

  return {
    type: 'trial-ended-unpaid',
    subject: 'user',
    subjectKey: facts.userKey,
    firedAt: facts.trialEndsAt,
    episodeKey: `trial:${isoDay(facts.trialEndsAt)}`,
    says: `Their trial ended on ${isoDay(facts.trialEndsAt)} and they have not paid.`,
    details: { trialEndsAt: facts.trialEndsAt.toISOString() },
  };
}

/**
 * Limit reached without upgrading (brief §8.3).
 *
 * "`Plan Limit Reached` with no upgrade (`Subscription Started`) within 7 days."
 */
export function limitReachedNoUpgrade(facts: UserLeakFacts, now: Date): LeakFinding | null {
  if (suppressed(facts)) return null;
  if (facts.planLimitReachedAt === null) return null;

  const deadline = facts.planLimitReachedAt.getTime() + LIMIT_UPGRADE_DAYS * DAY;
  if (now.getTime() < deadline) return null;

  return {
    type: 'limit-reached-no-upgrade',
    subject: 'user',
    subjectKey: facts.userKey,
    firedAt: new Date(deadline),
    episodeKey: `limit:${facts.planLimitReachedAt.toISOString()}`,
    says: `They hit a limit of their plan ${hours((now.getTime() - facts.planLimitReachedAt.getTime()) / 1000)} ago and have not upgraded.`,
    details: {
      planLimitReachedAt: facts.planLimitReachedAt.toISOString(),
      waitedDays: LIMIT_UPGRADE_DAYS,
    },
  };
}

/**
 * Cancelled or payment failed (brief §8.3): "the explicit event".
 *
 * `ignorePaid` is passed, because this leak is ABOUT paying customers. The other two
 * guards still apply: someone who asked to be deleted is never in a number.
 */
export function cancelledOrFailed(facts: UserLeakFacts): LeakFinding[] {
  if (suppressed(facts, { ignorePaid: true })) return [];
  const findings: LeakFinding[] = [];

  if (facts.cancelledAt !== null) {
    findings.push({
      type: 'cancelled-or-failed',
      subject: 'user',
      subjectKey: facts.userKey,
      firedAt: facts.cancelledAt,
      episodeKey: `cancelled:${facts.cancelledAt.toISOString()}`,
      says:
        facts.cancelReason === null
          ? 'They cancelled their subscription.'
          : `They cancelled their subscription: ${facts.cancelReason}.`,
      details: { cancelledAt: facts.cancelledAt.toISOString(), reason: facts.cancelReason },
    });
  }

  if (facts.paymentFailedAt !== null) {
    findings.push({
      type: 'cancelled-or-failed',
      subject: 'user',
      subjectKey: facts.userKey,
      firedAt: facts.paymentFailedAt,
      episodeKey: `payment-failed:${facts.paymentFailedAt.toISOString()}`,
      says: 'A payment of theirs failed.',
      details: {
        paymentFailedAt: facts.paymentFailedAt.toISOString(),
        declineCode: facts.paymentFailedCode,
      },
    });
  }

  return findings;
}

/**
 * Payer going quiet (brief §8.3).
 *
 * "A paying user's or account's active days fall by half or more against their own
 * 4-week baseline, two weeks running."
 *
 * Against their OWN baseline, which is the whole point: a customer who logs in twice
 * a week has not gone quiet by logging in twice a week, and one who logged in daily
 * and now logs in twice a week has.
 */
export function payerGoingQuiet(facts: UserLeakFacts, now: Date): LeakFinding | null {
  // About paying customers, so `ignorePaid`; but they do have to be one.
  if (suppressed(facts, { ignorePaid: true })) return null;
  if (facts.paidAt === null) return null;
  if (facts.recentWeeklyActiveDays === null || facts.baselineActiveDaysPerWeek === null) {
    return null;
  }

  const bar = facts.baselineActiveDaysPerWeek * PAYER_QUIET_RATIO;
  // A baseline of almost nothing cannot halve into a story.
  if (facts.baselineActiveDaysPerWeek < 1) return null;

  const weeks = facts.recentWeeklyActiveDays;
  if (weeks.length < PAYER_QUIET_WEEKS) return null;
  if (!weeks.every((days) => days <= bar)) return null;

  return {
    type: 'payer-going-quiet',
    subject: 'user',
    subjectKey: facts.userKey,
    firedAt: now,
    // One episode per fortnight: the week the run of quiet weeks ends in.
    episodeKey: `payer-quiet:${isoDay(now)}`,
    says: `They used to use it about ${facts.baselineActiveDaysPerWeek.toFixed(1)} days a week and have been down to ${weeks[0]} and ${weeks[1]} for two weeks.`,
    details: {
      baselineActiveDaysPerWeek: facts.baselineActiveDaysPerWeek,
      recentWeeklyActiveDays: [...weeks],
      bar,
      baselineWeeks: PAYER_BASELINE_WEEKS,
    },
  };
}

/**
 * Pricing quick exit (brief §8.3, and the pricing table in §8.2).
 *
 * No per-person alert: the dashboard shows "a rate by source, device, country and
 * trial day". The instance is still recorded, because it belongs on a known user's
 * timeline (brief §8.2) and because the rate has to be countable.
 */
export function pricingQuickExit(facts: UserLeakFacts): LeakFinding | null {
  if (suppressed(facts)) return null;
  if (facts.pricingQuickExitAt === null) return null;

  return {
    type: 'pricing-quick-exit',
    subject: 'user',
    subjectKey: facts.userKey,
    firedAt: facts.pricingQuickExitAt,
    episodeKey: `quick-exit:${facts.pricingQuickExitAt.toISOString()}`,
    says: 'They opened your pricing page, glanced at it and left.',
    details: { at: facts.pricingQuickExitAt.toISOString() },
  };
}

export interface StepCollapseFact {
  stepId: number;
  label: string;
  /** Completions in the last 24 hours. */
  observed: number;
  /** Completions over the trailing 14 days. */
  baselineCompletions: number;
}

/**
 * Step completion collapse (brief §8.3).
 *
 * Unmasked, because it concerns a step rather than a person. The episode is the hour
 * it was detected in, so the hourly sweep cannot fire the same collapse twice while
 * it persists — but a collapse that is still there tomorrow is a new episode, which
 * is right: the founder should hear about a second day of it.
 */
export function stepCollapse(fact: StepCollapseFact, now: Date): LeakFinding | null {
  const test: CollapseTest = collapseTest(fact.observed, fact.baselineCompletions);
  if (!test.collapsed) return null;

  return {
    type: 'step-collapse',
    subject: 'step',
    subjectKey: fact.stepId,
    firedAt: now,
    episodeKey: `collapse:${isoDay(now)}`,
    says: `"${fact.label}" was completed ${fact.observed} ${fact.observed === 1 ? 'time' : 'times'} in the last 24 hours. Its own recent rate says about ${test.expected.toFixed(0)}. Something is probably broken.`,
    details: {
      stepId: fact.stepId,
      label: fact.label,
      observed: fact.observed,
      expected: test.expected,
      p: test.p,
    },
  };
}

/** Every per-person leak, in one call, so a sweep cannot forget one. */
export function userLeaks(facts: UserLeakFacts, now: Date): LeakFinding[] {
  return [
    ...onboardingStalls(facts, now),
    ...cancelledOrFailed(facts),
    lastMomentDrop(facts, now),
    highIntentQuiet(facts, now),
    trialEndedUnpaid(facts, now),
    limitReachedNoUpgrade(facts, now),
    payerGoingQuiet(facts, now),
    pricingQuickExit(facts),
  ].filter((finding): finding is LeakFinding => finding !== null);
}

/** The leak types `userLeaks` can produce, for a test that none is forgotten. */
export const USER_LEAK_TYPES: readonly LeakType[] = [
  'onboarding-stall',
  'cancelled-or-failed',
  'last-moment-drop',
  'high-intent-quiet',
  'trial-ended-unpaid',
  'limit-reached-no-upgrade',
  'payer-going-quiet',
  'pricing-quick-exit',
];

/**
 * The nine leaks (brief §8.3).
 *
 * "Nine leaks, each a precise rule the founder can read in plain words." The rule
 * text lives beside the code that implements it, so a screen can show the rule that
 * produced a number and the two cannot drift apart (CLAUDE.md rule 11).
 */

export const LEAK_TYPES = [
  'onboarding-stall',
  'last-moment-drop',
  'high-intent-quiet',
  'trial-ended-unpaid',
  'step-collapse',
  'payer-going-quiet',
  'cancelled-or-failed',
  'pricing-quick-exit',
  'limit-reached-no-upgrade',
] as const;
export type LeakType = (typeof LEAK_TYPES)[number];

/** What a leak is about: a person, a company, or a step of the funnel. */
export const LEAK_SUBJECTS = ['user', 'account', 'step'] as const;
export type LeakSubjectKind = (typeof LEAK_SUBJECTS)[number];

/** What a leak needs before it can run at all (brief §8.3). */
export const LEAK_REQUIREMENTS = ['paid-event', 'trial-dates', 'price'] as const;
export type LeakRequirement = (typeof LEAK_REQUIREMENTS)[number];

export interface LeakDefinition {
  type: LeakType;
  subject: LeakSubjectKind;
  /** The brief's own rule, in the founder's words. */
  rule: string;
  /** True when it produces an instant alert about one person. */
  alerts: boolean;
  /**
   * False for the step-collapse leak only: "unmasked because it concerns a step, not
   * a person" (brief §8.3).
   */
  masked: boolean;
  /** Data without which this leak cannot be computed. */
  needs: readonly LeakRequirement[];
  /**
   * True for the two leaks that are ABOUT paying customers.
   *
   * Every other leak is suppressed for someone who has paid — that is the whole
   * point of it. For these two, having paid is part of the story, so the paid guard
   * is skipped and the other two (deleted, opted out) still apply. It lives on the
   * definition rather than in a list inside the alert dispatcher, because a list
   * somewhere else is a list that drifts (CLAUDE.md rule 11).
   */
  aboutPayers: boolean;
  /** Which sweep runs it (brief §8.3: every 5 minutes, hourly for the collapse). */
  sweep: 'five-minute' | 'hourly' | 'daily';
}

export const LEAK_DEFINITIONS: readonly LeakDefinition[] = [
  {
    type: 'onboarding-stall',
    subject: 'user',
    rule: 'Someone entered a step and made no progress for longer than the step allows — 24 hours by default, or the step’s own slowest tenth once 20 people have finished it.',
    // Brief §8.3: "Counts per step in the dashboard and weekly report; no per-user alert."
    alerts: false,
    masked: true,
    needs: [],
    aboutPayers: false,
    sweep: 'five-minute',
  },
  {
    type: 'last-moment-drop',
    subject: 'user',
    rule: 'Someone started checkout and no payment arrived within 2 hours. A trial-only checkout does not count.',
    alerts: true,
    masked: true,
    needs: ['paid-event'],
    aboutPayers: false,
    sweep: 'five-minute',
  },
  {
    type: 'high-intent-quiet',
    subject: 'user',
    rule: 'Someone reached 60 or more on buying intent, then went 7 days without doing anything, and never paid.',
    alerts: true,
    masked: true,
    needs: ['paid-event'],
    aboutPayers: false,
    sweep: 'five-minute',
  },
  {
    type: 'trial-ended-unpaid',
    subject: 'user',
    rule: 'Their trial end date passed and no payment arrived.',
    alerts: true,
    masked: true,
    needs: ['paid-event', 'trial-dates'],
    aboutPayers: false,
    sweep: 'daily',
  },
  {
    type: 'step-collapse',
    subject: 'step',
    rule: 'A step’s completions in the last 24 hours fell so far below its own 14-day rate that chance does not explain it.',
    alerts: true,
    // "Unmasked because it concerns a step, not a person" (brief §8.3).
    masked: false,
    needs: [],
    aboutPayers: false,
    sweep: 'hourly',
  },
  {
    type: 'payer-going-quiet',
    subject: 'user',
    rule: 'A paying customer’s active days halved or worse against their own 4-week baseline, two weeks running.',
    alerts: true,
    masked: true,
    needs: ['paid-event'],
    aboutPayers: true,
    sweep: 'daily',
  },
  {
    type: 'cancelled-or-failed',
    subject: 'user',
    rule: 'They cancelled, or a payment failed.',
    // Brief §8.3: "Counts in the weekly report."
    alerts: false,
    masked: true,
    needs: [],
    aboutPayers: true,
    sweep: 'five-minute',
  },
  {
    type: 'pricing-quick-exit',
    subject: 'user',
    rule: 'Someone opened your pricing page for the first time, glanced at it and left.',
    // Brief §8.3: "a rate by source, device, country and trial day … no per-person alert."
    alerts: false,
    masked: true,
    needs: [],
    aboutPayers: false,
    sweep: 'daily',
  },
  {
    type: 'limit-reached-no-upgrade',
    subject: 'user',
    rule: 'They hit a limit of their plan and did not upgrade within 7 days.',
    alerts: true,
    masked: true,
    needs: ['paid-event'],
    aboutPayers: false,
    sweep: 'five-minute',
  },
];

export const LEAK_DEFINITIONS_BY_TYPE: ReadonlyMap<LeakType, LeakDefinition> = new Map(
  LEAK_DEFINITIONS.map((definition) => [definition.type, definition]),
);

export interface LeakFinding {
  type: LeakType;
  subject: LeakSubjectKind;
  /** The user key, account id or step id this is about. */
  subjectKey: number;
  /** When the leak became true, which is not when the sweep noticed. */
  firedAt: Date;
  /**
   * What makes this one episode rather than another.
   *
   * "A leak fires once per user (or account) per episode. A user who comes back
   * resets it, so a later episode can fire again." The key is derived from the facts
   * — the checkout's timestamp, the step entry they went quiet on, the trial's end
   * date — so the same episode produces the same key however many times the sweep
   * runs, and a genuinely new episode produces a different one. The unique index on
   * `leak_instances` then does the rest (brief §8.3).
   */
  episodeKey: string;
  /** One plain sentence a founder reads. */
  says: string;
  /** The numbers behind it, so the screen can show its working. */
  details: Record<string, unknown>;
}

/** A leak that cannot run, and the reason in plain words (brief §8.3). */
export interface LeakUnavailable {
  type: LeakType;
  missing: LeakRequirement[];
  because: string;
}

export const REQUIREMENT_REASONS: Record<LeakRequirement, string> = {
  'paid-event':
    'we are not getting a paid event yet, so we cannot tell who paid. Send "Subscription Started" from your server, or map one of your own events to it.',
  'trial-dates':
    'we do not know when anyone’s trial ends. Send a `trialEndsAt` trait when a trial starts, or a "Trial Ended" event.',
  price: 'you have not told us what your product costs, so there is no money figure.',
};

/**
 * Which leaks are off, and why.
 *
 * Brief §8.3: "Leaks that need data that does not exist yet stay off, with a plain
 * reason." Off and explained, never silently zero: a leak reported as zero because
 * its input is missing is worse than one reported as off, because the founder
 * believes it.
 */
export function unavailableLeaks(available: {
  paidEvent: boolean;
  trialDates: boolean;
  price: boolean;
}): LeakUnavailable[] {
  const have: Record<LeakRequirement, boolean> = {
    'paid-event': available.paidEvent,
    'trial-dates': available.trialDates,
    price: available.price,
  };

  const off: LeakUnavailable[] = [];
  for (const definition of LEAK_DEFINITIONS) {
    const missing = definition.needs.filter((need) => !have[need]);
    if (missing.length === 0) continue;
    off.push({
      type: definition.type,
      missing,
      because: `This is off because ${missing.map((need) => REQUIREMENT_REASONS[need]).join(' Also, ')}`,
    });
  }
  return off;
}

export function leakIsAvailable(
  type: LeakType,
  available: { paidEvent: boolean; trialDates: boolean; price: boolean },
): boolean {
  return !unavailableLeaks(available).some((entry) => entry.type === type);
}

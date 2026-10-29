import { rate } from '../funnel/stats.js';
/*
 * How different the two rates have to be before the change gets credit or blame.
 *
 * The funnel's own "same rate" tolerance, reused rather than invented here, so "no
 * real change" means the same thing on the dashboard and in the weekly report.
 */
import { SAME_RATE_TOLERANCE } from '../funnel/highlight.js';
import { plural } from '../money.js';

/**
 * Before-and-after proof (brief §9's "Changes").
 *
 * "The founder marks a change on a step with its date. The dashboard compares equal
 * windows before and after for that step, and the weekly report repeats it: 'Since
 * you changed step 2, completion went from {a}% to {b}% across {n} users.' Show 'too
 * early to tell' until each window has at least 100 users entering the step. On Free
 * the comparison spans at most 45 days on each side. Freeze the result when it is
 * computed."
 *
 * The honesty is the feature. A founder who shortened a form wants to be told it
 * worked, and the easiest way to tell them is to compare 40 users against 12 and
 * report a 9-point gain that is noise. So the minimum is a hard gate, EQUAL windows
 * are a hard rule, and the sentence says the user count out loud so the founder can
 * judge it themselves.
 */

/**
 * Brief §9: "Show 'too early to tell' until each window has at least 100 users
 * entering the step." Each window, not both together: 180 before and 20 after is
 * still too early.
 */
export const MIN_USERS_PER_WINDOW = 100;

/** Brief §9: "On Free the comparison spans at most 45 days on each side." */
export const FREE_WINDOW_DAYS_MAX = 45;

export interface ChangeWindow {
  from: Date;
  to: Date;
  /** Users who entered the step inside the window. */
  entered: number;
  /** How many of those completed it. */
  completed: number;
}

/** The pair of windows a comparison is measured over. */
export interface WindowPair {
  before: { from: Date; to: Date };
  after: { from: Date; to: Date };
  /** How many days each side spans. Equal by construction. */
  days: number;
  /** True when the window was shortened by the plan's cap rather than by the clock. */
  cappedByPlan: boolean;
}

/**
 * The two windows to measure, equal in length.
 *
 * The length is however long it has been since the change, capped by the plan — so
 * the comparison starts narrow and widens day by day until it hits the cap. Equal
 * lengths are not a nicety: a 7-day "after" against a 45-day "before" compares a
 * week of one product against six weeks of another, and whichever way the number
 * moved, the founder would have learnt nothing.
 */
export function equalWindows(happenedAt: Date, now: Date, maxDays: number): WindowPair {
  const elapsedMs = Math.max(0, now.getTime() - happenedAt.getTime());
  const elapsedDays = elapsedMs / 86_400_000;
  const days = Math.min(elapsedDays, maxDays);
  const span = days * 86_400_000;

  return {
    before: { from: new Date(happenedAt.getTime() - span), to: happenedAt },
    after: { from: happenedAt, to: new Date(happenedAt.getTime() + span) },
    days,
    cappedByPlan: elapsedDays > maxDays,
  };
}

export type ChangeVerdict =
  /** Not enough users on one side or the other yet. */
  | 'too-early'
  | 'improved'
  | 'worse'
  /** Enough users, and the rate did not really move. */
  | 'no-change';

export interface ChangeComparison {
  verdict: ChangeVerdict;
  /** Completion rate before, 0–1. Null when nobody entered. */
  beforeRate: number | null;
  afterRate: number | null;
  beforeEntered: number;
  afterEntered: number;
  /** Users across both windows, which is the {n} in the brief's sentence. */
  users: number;
  windowDays: number;
  cappedByPlan: boolean;
  /** The sentence the dashboard and the weekly report both print. */
  says: string;
  /** How it was worked out, shown beside the number (rule 7). */
  formula: string;
  /** True once this can be stored and never recomputed (brief §9: "freeze"). */
  final: boolean;
}

export interface ChangeComparisonInput {
  /** The step's own label, or null for a change to the whole funnel. */
  stepLabel: string | null;
  before: ChangeWindow;
  after: ChangeWindow;
  windows: WindowPair;
}

export function compareChange(input: ChangeComparisonInput): ChangeComparison {
  const { before, after, windows } = input;
  const beforeRate = rate(before.completed, before.entered);
  const afterRate = rate(after.completed, after.entered);
  const subject = input.stepLabel === null ? 'your funnel' : input.stepLabel;
  const users = before.entered + after.entered;

  const formula =
    `completed ÷ entered, over ${days(windows.days)} either side of the change. ` +
    `Before: ${before.completed} of ${before.entered}. After: ${after.completed} of ${after.entered}.`;

  const base = {
    beforeRate,
    afterRate,
    beforeEntered: before.entered,
    afterEntered: after.entered,
    users,
    windowDays: windows.days,
    cappedByPlan: windows.cappedByPlan,
    formula,
  };

  /*
   * Too early, and said as a number rather than as a shrug.
   *
   * "Too early to tell" on its own invites a founder to refresh the page tomorrow and
   * again the day after. Telling them they have 41 of the 100 they need turns it into
   * a wait with an end.
   */
  if (
    before.entered < MIN_USERS_PER_WINDOW ||
    after.entered < MIN_USERS_PER_WINDOW ||
    beforeRate === null ||
    afterRate === null
  ) {
    const short = Math.min(before.entered, after.entered);
    return {
      ...base,
      verdict: 'too-early',
      says:
        `Too early to tell. We compare equal windows either side of the change and need ` +
        `${MIN_USERS_PER_WINDOW} users entering ${subject} in each. ` +
        `So far: ${before.entered} before and ${after.entered} after` +
        (short === 0
          ? '.'
          : `, so ${plural(MIN_USERS_PER_WINDOW - short, 'more user')} on the thinner side.`),
      final: false,
    };
  }

  const moved = afterRate - beforeRate;
  const same = Math.abs(moved) <= SAME_RATE_TOLERANCE * Math.max(beforeRate, 0.0001);
  const from = percent(beforeRate);
  const to = percent(afterRate);

  if (same) {
    return {
      ...base,
      verdict: 'no-change',
      says:
        `Since you changed ${subject}, completion went from ${from} to ${to} across ` +
        `${plural(users, 'user')} — close enough to call it unchanged.`,
      final: true,
    };
  }

  return {
    ...base,
    verdict: moved > 0 ? 'improved' : 'worse',
    says: `Since you changed ${subject}, completion went from ${from} to ${to} across ${plural(users, 'user')}.`,
    final: true,
  };
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function days(value: number): string {
  const whole = Math.round(value);
  return whole === 1 ? '1 day' : `${whole} days`;
}

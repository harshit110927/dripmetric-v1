import { HIGH_INTENT_THRESHOLD } from './points.js';

/**
 * "Intent but didn't pay" and potential revenue (brief §8.2 and §9).
 *
 * "A user whose score reached 60 (store `first_high_at`) and who has not paid. Count
 * two groups: past the window (more than W days since `first_high_at`, where W is the
 * project's setting, default 14) and still inside the window. Potential revenue for
 * 'didn't pay' uses the past-window group; show the in-window group beside it as
 * 'still time'. A user who pays later leaves both groups. This needs the paid event."
 */

/** Settled decision 7's default. The per-project setting overrides it. */
export const DEFAULT_DIDNT_PAY_WINDOW_DAYS = 14;

export interface DidntPayCandidate {
  userKey: number;
  /** The first time their score crossed 60. Null for anyone who never did. */
  firstHighAt: Date | null;
  peakScore: number;
  paidAt: Date | null;
  /** Excluded outright: no number is ever about someone who asked to be deleted. */
  excluded?: boolean;
}

export interface DidntPayGroups {
  /** More than W days since they first reached 60, and still no payment. */
  pastWindow: DidntPayCandidate[];
  /** Inside the window: shown beside it as "still time". */
  insideWindow: DidntPayCandidate[];
  /** The window used, so the screen can say "more than 14 days". */
  windowDays: number;
}

/**
 * Splits the people who reached high intent and have not paid.
 *
 * A user who pays later leaves both groups, which is why `paidAt` is checked rather
 * than a stored flag: the moment their payment lands they stop being a leak, and a
 * flag would need a second job to remember that.
 */
export function didntPayGroups(
  candidates: readonly DidntPayCandidate[],
  now: Date,
  // TODO(decision-7): W is the project's `didntPayWindowDays` setting. It is a
  // manual per-project number on purpose — settled decision 7 says not to build
  // trial-aware logic, so nothing here may derive it from the trial length.
  windowDays: number = DEFAULT_DIDNT_PAY_WINDOW_DAYS,
): DidntPayGroups {
  const pastWindow: DidntPayCandidate[] = [];
  const insideWindow: DidntPayCandidate[] = [];

  for (const candidate of candidates) {
    if (candidate.excluded === true) continue;
    if (candidate.firstHighAt === null) continue;
    if (candidate.peakScore < HIGH_INTENT_THRESHOLD) continue;
    // Paying removes them from both groups, whenever it happened.
    if (candidate.paidAt !== null) continue;

    const days = (now.getTime() - candidate.firstHighAt.getTime()) / 86_400_000;
    if (days > windowDays) pastWindow.push(candidate);
    else insideWindow.push(candidate);
  }

  return { pastWindow, insideWindow, windowDays };
}

export interface PotentialRevenue {
  /** Minor units, like Stripe. Never a float (CLAUDE.md invariants). */
  amountMinor: number;
  currency: string;
  users: number;
  pricePerUserMinor: number;
  /** The formula, shown on screen beside the number (brief §9, decision 14). */
  formula: string;
}

/**
 * Potential revenue = leaked users × the founder's list price (brief §2).
 *
 * "With the formula shown on screen… Real dollars at risk come only from Stripe in a
 * later layer. Never add it to Stripe dollars."
 *
 * The formula text is returned with the number rather than written into the template,
 * so the screen cannot show one and compute the other.
 */
export function potentialRevenue(
  users: number,
  listPriceMinor: number | null,
  currency: string,
  interval: 'month' | 'year' = 'month',
): PotentialRevenue | null {
  // No price confirmed means no money claim. A guessed price would be a made-up
  // number on a screen whose whole promise is that every number can be checked.
  if (listPriceMinor === null || listPriceMinor <= 0) return null;

  const amountMinor = users * listPriceMinor;
  const price = (listPriceMinor / 100).toFixed(2);

  return {
    amountMinor,
    currency,
    users,
    pricePerUserMinor: listPriceMinor,
    formula: `${users} ${users === 1 ? 'user' : 'users'} × ${price} ${currency.toUpperCase()} per ${interval} = ${(amountMinor / 100).toFixed(2)} ${currency.toUpperCase()} per ${interval}`,
  };
}

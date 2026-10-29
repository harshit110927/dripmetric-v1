/**
 * The intent points table (brief §8.2), encoded as data.
 *
 * "A 0 to 100 score from transparent rules." Transparent means every point a founder
 * sees can name the rule that produced it, so the table carries its own words. This
 * file is the one place the numbers live: the score, the fixtures, the per-project
 * config and the calibration report all read it (CLAUDE.md rule 11).
 *
 * "Each signal counts once unless its row says otherwise" — every row here is
 * once-only, and the ones the brief marks as shared share a key so they cannot both
 * fire.
 */

export const INTENT_SIGNAL_KEYS = [
  'checkoutStarted',
  'activated',
  'planLimitOrPaywall',
  'pricingViewed',
  'pricingDeliberation',
  'inviteSent',
  'integrationOrImport',
  'coreActionEarly',
  'activeThreeOfSeven',
  'fastActivation',
  'paymentMethodBeforeTrialEnd',
  'salesContactRequested',
  'fitPoints',
  'disposableEmail',
] as const;
export type IntentSignalKey = (typeof INTENT_SIGNAL_KEYS)[number];

export interface IntentSignalDefinition {
  key: IntentSignalKey;
  points: number;
  /** The brief's own rule text, shown to the founder beside the points. */
  rule: string;
  /** What the founder reads on a timeline when this signal is true. */
  says: string;
}

export const INTENT_POINTS: readonly IntentSignalDefinition[] = [
  {
    key: 'checkoutStarted',
    points: 30,
    rule: 'Started checkout, except a checkout that only starts a card-up-front trial.',
    says: 'They started checking out.',
  },
  {
    key: 'activated',
    points: 25,
    rule: 'Reached activation. Once.',
    says: 'They got to the point where the product works for them.',
  },
  {
    key: 'planLimitOrPaywall',
    points: 20,
    rule: 'Hit a plan limit, or saw an upgrade prompt at a paywall. Counted once, shared.',
    says: 'They ran into a limit of their plan.',
  },
  {
    key: 'pricingViewed',
    points: 10,
    rule: 'Looked at pricing for longer than the attention threshold.',
    says: 'They read the pricing page.',
  },
  {
    key: 'pricingDeliberation',
    points: 10,
    rule: 'Weighed the plans: long enough on pricing, a second visit, the annual toggle, a plan click or the FAQ.',
    says: 'They went back and forth over the plans.',
  },
  {
    key: 'inviteSent',
    points: 15,
    rule: 'Invited someone. Once.',
    says: 'They invited a colleague.',
  },
  {
    key: 'integrationOrImport',
    points: 10,
    rule: 'Connected an integration or imported data. Once, shared.',
    says: 'They put their own data or tools into it.',
  },
  {
    key: 'coreActionEarly',
    points: 10,
    rule: 'Did the core action three or more times in the first 14 days after signing up.',
    says: 'They used the main feature repeatedly in their first two weeks.',
  },
  {
    key: 'activeThreeOfSeven',
    points: 10,
    rule: 'Active on three or more of the last seven days.',
    says: 'They keep coming back.',
  },
  {
    key: 'fastActivation',
    points: 10,
    rule: 'Reached activation faster than your median time to value.',
    says: 'They got going faster than most of your users.',
  },
  {
    key: 'paymentMethodBeforeTrialEnd',
    points: 15,
    rule: 'Added a payment method before the trial ended, on a trial that started without a card.',
    says: 'They added a card before they had to.',
  },
  {
    key: 'salesContactRequested',
    points: 20,
    rule: 'Asked to talk to someone.',
    says: 'They asked to talk to you.',
  },
  {
    key: 'fitPoints',
    points: 5,
    rule: 'Five points for each sign they look like a buyer, up to ten in total.',
    says: 'They look like the kind of user who pays.',
  },
  {
    key: 'disposableEmail',
    points: -20,
    rule: 'Signed up with a throwaway address.',
    says: 'They signed up with a throwaway address.',
  },
];

export const INTENT_POINTS_BY_KEY: ReadonlyMap<IntentSignalKey, IntentSignalDefinition> = new Map(
  INTENT_POINTS.map((signal) => [signal.key, signal]),
);

/**
 * Fit points: +5 each, "total capped at 10" (brief §8.2).
 *
 * The cap is the point of the row. Five separate facts about a person, each weakly
 * predictive, must not add up to half the high-intent threshold on their own.
 */
export const FIT_POINT_KEYS = [
  'workEmail',
  'desktopAtSignup',
  'workingHoursSignup',
  'reviewOrBrandSearch',
  'repeatVisitorBeforeSignup',
] as const;
export type FitPointKey = (typeof FIT_POINT_KEYS)[number];

export const FIT_POINTS_EACH = 5;
export const FIT_POINTS_CAP = 10;

export const FIT_POINT_RULES: Record<FitPointKey, string> = {
  workEmail: 'Signed up with a work address.',
  desktopAtSignup: 'Signed up on a desktop (team products only; off for mobile-first products).',
  workingHoursSignup: 'Signed up during working hours on a weekday.',
  reviewOrBrandSearch:
    'Arrived from a review or comparison site, or from a search for your product by name.',
  repeatVisitorBeforeSignup: 'Visited two or more times before signing up.',
};

/**
 * Bands (brief §8.2): "0 to 29 low, 30 to 59 warm, 60 to 100 high."
 *
 * 60 is the number that matters: it is what "intent but didn't pay" is counted from,
 * and what the calibration job reports recall and precision for.
 */
export const BAND_WARM_FROM = 30;
export const BAND_HIGH_FROM = 60;
export const HIGH_INTENT_THRESHOLD = BAND_HIGH_FROM;

export const INTENT_BANDS = ['low', 'warm', 'high'] as const;
export type IntentBand = (typeof INTENT_BANDS)[number];

export function bandOf(score: number): IntentBand {
  if (score >= BAND_HIGH_FROM) return 'high';
  if (score >= BAND_WARM_FROM) return 'warm';
  return 'low';
}

/** Brief §8.2: "intent halves after each quiet week." */
export const DECAY_HALF_LIFE_DAYS = 7;

export const MAX_SCORE = 100;
export const MIN_SCORE = 0;

/**
 * Signals stored as evidence that carry no points yet (brief §8.2).
 *
 * "Signals in Appendix A that have no value in this table … are stored as evidence
 * and add 0 points until calibration. Do not invent points; list them in
 * docs/decisions.md."
 *
 * They are listed here as well as in the decisions log, because a reader of the code
 * needs to know the omission is deliberate rather than an oversight.
 */
export const ZERO_POINT_EVIDENCE = [
  'Plan Selected',
  'Evaluation Page Viewed',
  'Trial Extension Requested',
  'Upgrade Prompt Clicked',
  'Plan Limit Approached',
  'Trial Started',
  'Signed In',
  'Data Exported',
] as const;

/**
 * Three or more dismissals sets a flag and no points (brief §8.2).
 *
 * "Sets a 'price objection' flag: a different problem, not lower intent." Someone
 * repeatedly saying no to a price is interested in the product and unhappy with the
 * number, which is the opposite of a cold user — so it must not move the score.
 */
export const PRICE_OBJECTION_DISMISSALS = 3;

/** Brief §8.2: the pricing attention default, before the product has its own. */
export const PRICING_ATTENTION_SECONDS = 10;
/** "Once the product has 50 pricing views, the threshold becomes its own 25th percentile." */
export const PRICING_VIEWS_FOR_OWN_THRESHOLD = 50;
/** Brief §8.2: a median time to value "needs enough activations (assume 20 and record it)". */
export const ACTIVATIONS_FOR_MEDIAN_TTV = 20;
/** Brief §8.2: "Core Action 3 or more times in the first 14 days". */
export const CORE_ACTION_EARLY_COUNT = 3;
export const CORE_ACTION_EARLY_DAYS = 14;
/** Brief §8.2: "Active on 3 or more of the last 7 days." */
export const ACTIVE_DAYS_REQUIRED = 3;
export const ACTIVE_DAYS_WINDOW = 7;
/** Brief §8.2, B2B accounts: "+10 when two or more members were active that week." */
export const ACCOUNT_ACTIVE_MEMBERS_BONUS = 10;
export const ACCOUNT_ACTIVE_MEMBERS_REQUIRED = 2;

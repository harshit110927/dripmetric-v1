import {
  bandOf,
  DECAY_HALF_LIFE_DAYS,
  FIT_POINTS_CAP,
  FIT_POINTS_EACH,
  FIT_POINT_KEYS,
  FIT_POINT_RULES,
  INTENT_POINTS,
  INTENT_POINTS_BY_KEY,
  MAX_SCORE,
  MIN_SCORE,
  type FitPointKey,
  type IntentBand,
  type IntentSignalKey,
} from './points.js';

/**
 * The intent score (brief §8.2).
 *
 *   S_now = min(100, Σ p_i) × 2^(−d/7)
 *
 * where `p_i` are the points of each signal currently true and `d` is the days since
 * the user's last event. Clamped to 0–100.
 *
 * Two numbers are kept per user: the **current** score, computed here from stored
 * facts and `now`, and the **peak**, updated when events are ingested. The peak is
 * what drives "intent but didn't pay" — a user who reached 85 and went quiet has not
 * become uninterested, they have become a leak.
 *
 * Pure: facts and `now` in, a result out, no I/O and no clock (CLAUDE.md rule 9).
 */

/**
 * The facts the score needs, all of them derivable from stored events.
 *
 * Deliberately booleans and counts rather than event lists: this is the row that gets
 * stored, and it is what makes a score recomputable (CLAUDE.md rule 10).
 */
export interface IntentFacts {
  /** Null for someone who has never done anything, which scores 0. */
  lastEventAt: Date | null;

  checkoutStarted: boolean;
  activated: boolean;
  planLimitOrPaywall: boolean;
  pricingViewed: boolean;
  pricingDeliberation: boolean;
  inviteSent: boolean;
  integrationOrImport: boolean;
  coreActionEarly: boolean;
  activeThreeOfSeven: boolean;
  fastActivation: boolean;
  paymentMethodBeforeTrialEnd: boolean;
  salesContactRequested: boolean;
  disposableEmail: boolean;

  /** Which fit points are true. Five each, ten in total at most. */
  fit: Partial<Record<FitPointKey, boolean>>;

  /** Three or more upgrade-prompt dismissals: a flag, not a score change. */
  priceObjection: boolean;
}

export function emptyFacts(): IntentFacts {
  return {
    lastEventAt: null,
    checkoutStarted: false,
    activated: false,
    planLimitOrPaywall: false,
    pricingViewed: false,
    pricingDeliberation: false,
    inviteSent: false,
    integrationOrImport: false,
    coreActionEarly: false,
    activeThreeOfSeven: false,
    fastActivation: false,
    paymentMethodBeforeTrialEnd: false,
    salesContactRequested: false,
    disposableEmail: false,
    fit: {},
    priceObjection: false,
  };
}

export interface ScoredSignal {
  key: IntentSignalKey;
  points: number;
  /** The rule, in the brief's words. */
  rule: string;
  /** What the founder reads. */
  says: string;
}

export interface IntentScore {
  /** Σ p_i before the cap and before decay. Shown so the maths is checkable. */
  rawPoints: number;
  /** min(100, Σ p_i), before decay. */
  basePoints: number;
  /** Days since their last event. Null when they have never done anything. */
  quietDays: number | null;
  /** 2^(−d/7). 1 for someone active today. */
  decayFactor: number;
  /** The final 0–100 score. */
  score: number;
  band: IntentBand;
  /** Every signal that contributed, in points order. */
  signals: ScoredSignal[];
  /** The fit points that were counted, and how many were dropped by the cap. */
  fit: { counted: FitPointKey[]; dropped: FitPointKey[]; points: number };
  /** A different problem, not lower intent (brief §8.2). */
  priceObjection: boolean;
  /** One line a founder can read, naming the biggest reasons. */
  explanation: string;
}

/**
 * Fit points, capped.
 *
 * The cap is applied by dropping the lowest-priority facts rather than by scaling,
 * so the two that count are always the same two for the same person — a score that
 * reshuffles its own reasons between reads is not explainable.
 */
function scoreFit(facts: IntentFacts): IntentScore['fit'] {
  const trueKeys = FIT_POINT_KEYS.filter((key) => facts.fit[key] === true);
  const allowed = Math.floor(FIT_POINTS_CAP / FIT_POINTS_EACH);
  const counted = trueKeys.slice(0, allowed);
  return {
    counted,
    dropped: trueKeys.slice(allowed),
    points: Math.min(FIT_POINTS_CAP, counted.length * FIT_POINTS_EACH),
  };
}

export function scoreIntent(facts: IntentFacts, now: Date): IntentScore {
  const signals: ScoredSignal[] = [];
  let rawPoints = 0;

  for (const definition of INTENT_POINTS) {
    if (definition.key === 'fitPoints') continue; // handled below, because of the cap
    if (facts[definition.key] !== true) continue;
    rawPoints += definition.points;
    signals.push({
      key: definition.key,
      points: definition.points,
      rule: definition.rule,
      says: definition.says,
    });
  }

  const fit = scoreFit(facts);
  if (fit.points > 0) {
    rawPoints += fit.points;
    const definition = INTENT_POINTS_BY_KEY.get('fitPoints')!;
    signals.push({
      key: 'fitPoints',
      points: fit.points,
      rule: definition.rule,
      says: fit.counted.map((key) => FIT_POINT_RULES[key]).join(' '),
    });
  }

  /*
   * The cap goes on BEFORE the decay, exactly as the brief writes it:
   * `min(100, Σ p_i) × 2^(−d/7)`.
   *
   * The other way round — decaying first and capping after — would let someone with
   * 180 points of signals sit at 100 for a fortnight, because the decay would have
   * eaten the surplus rather than the score. Nobody's intent is twice as durable for
   * having done everything twice.
   */
  const basePoints = Math.min(MAX_SCORE, rawPoints);

  const quietDays =
    facts.lastEventAt === null
      ? null
      : Math.max(0, (now.getTime() - facts.lastEventAt.getTime()) / 86_400_000);

  const decayFactor = quietDays === null ? 0 : Math.pow(2, -quietDays / DECAY_HALF_LIFE_DAYS);

  const score = clamp(basePoints * decayFactor);
  const sorted = [...signals].sort((a, b) => b.points - a.points);

  return {
    rawPoints,
    basePoints,
    quietDays,
    decayFactor,
    score,
    band: bandOf(score),
    signals: sorted,
    fit,
    priceObjection: facts.priceObjection,
    explanation: explain(sorted, basePoints, score, quietDays),
  };
}

/** Clamped to 0–100, and rounded, because a founder reads a whole number. */
function clamp(value: number): number {
  return Math.max(MIN_SCORE, Math.min(MAX_SCORE, Math.round(value)));
}

/**
 * One line naming the biggest reasons (CLAUDE.md rule 7: every number can show how it
 * is computed).
 */
function explain(
  signals: readonly ScoredSignal[],
  basePoints: number,
  score: number,
  quietDays: number | null,
): string {
  if (signals.length === 0) return 'Nothing they have done counts towards buying intent yet.';

  const top = signals.filter((signal) => signal.points > 0).slice(0, 3);
  const reasons = top.map((signal) => `${signal.says} (+${signal.points})`).join(' ');
  const negative = signals.filter((signal) => signal.points < 0);
  const minus = negative.map((signal) => `${signal.says} (${signal.points})`).join(' ');

  if (quietDays === null) return `${reasons} ${minus}`.trim();

  const quiet =
    score === basePoints
      ? ''
      : ` Their score is ${score} rather than ${basePoints} because they have not been back for ${Math.round(quietDays)} days.`;

  return `${reasons} ${minus}${quiet}`.replace(/\s+/g, ' ').trim();
}

/**
 * The peak score and the first crossing of the high threshold (brief §8.2).
 *
 * The peak is taken WITHOUT decay: it is the highest they ever got, and a peak that
 * decayed would not be a peak.
 *
 * It is REPLAYED from when each signal became true rather than accumulated as events
 * arrive. Two reasons, and the second is the real one:
 *
 *  - It is rebuildable (CLAUDE.md rule 10). A stored peak that could only be
 *    maintained forward would be lost the first time a mapping changed.
 *  - `firstHighAt` has to be a fact about the past. It is the clock "intent but
 *    didn't pay" counts from, and the calibration asks whether someone crossed 60
 *    *before* they paid — a timestamp stamped whenever a refresh happened to run
 *    could not answer that, and on a first run over months of history it would stamp
 *    everyone with today.
 */
export interface IntentPeak {
  peakScore: number;
  peakAt: Date | null;
  firstHighAt: Date | null;
}

/** One signal and the moment it became true. */
export interface SignalMoment {
  key: IntentSignalKey;
  at: Date;
}

export function replayPeak(
  moments: readonly SignalMoment[],
  facts: IntentFacts,
  highThreshold: number,
): IntentPeak {
  /*
   * The fit points are the starting line.
   *
   * They are true from the moment we knew who the person was, so they are not
   * moments in the timeline — they are the base every moment is added to.
   */
  const fit = scoreFit(facts);
  let running = fit.points;

  let peakScore = clamp(Math.min(MAX_SCORE, running));
  let peakAt: Date | null = null;
  let firstHighAt: Date | null = null;

  for (const moment of [...moments].sort((a, b) => a.at.getTime() - b.at.getTime())) {
    const definition = INTENT_POINTS_BY_KEY.get(moment.key);
    if (!definition || moment.key === 'fitPoints') continue;

    running += definition.points;
    const score = clamp(Math.min(MAX_SCORE, running));

    if (score > peakScore) {
      peakScore = score;
      peakAt = moment.at;
    }
    if (firstHighAt === null && score >= highThreshold) firstHighAt = moment.at;
  }

  return { peakScore, peakAt, firstHighAt };
}

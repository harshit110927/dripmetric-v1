import {
  HIGH_INTENT_THRESHOLD,
  INTENT_POINTS,
  INTENT_POINTS_BY_KEY,
  type IntentSignalKey,
} from './points.js';

/**
 * Calibration (brief §8.2).
 *
 * "Once a product has 30 paying conversions, report for the 60 threshold the recall
 * (the share of payers who crossed 60 before paying) and the precision (the share of
 * users above 60 who went on to pay), plus each signal's lift (conversion rate with
 * the signal against without it). When a signal's lift disagrees with its points,
 * suggest new weights for the founder to approve. **Never apply them automatically.**"
 *
 * That last sentence is the design. This file computes and suggests; nothing here
 * writes a weight. A score that re-weighted itself would stop being the transparent
 * rule set the founder was shown, and they would have no way to tell.
 */

/** Brief §8.2: "once a product has 30 paying conversions". */
export const MIN_PAYERS_FOR_CALIBRATION = 30;

export interface CalibrationUser {
  userKey: number;
  /** Their highest score ever. */
  peakScore: number;
  /** When they first crossed 60, if they did. */
  firstHighAt: Date | null;
  paidAt: Date | null;
  /** Which signals were ever true for them. */
  signals: ReadonlySet<IntentSignalKey>;
}

export interface SignalLift {
  key: IntentSignalKey;
  points: number;
  /** Conversion rate among users with the signal. */
  withRate: number | null;
  withoutRate: number | null;
  /** withRate ÷ withoutRate. Null when either side is too small to divide. */
  lift: number | null;
  withUsers: number;
  withoutUsers: number;
  /** A suggestion for the founder to approve, or null when the points look right. */
  suggestion: WeightSuggestion | null;
}

export interface WeightSuggestion {
  key: IntentSignalKey;
  currentPoints: number;
  suggestedPoints: number;
  /** Why, in plain words. The founder approves or ignores it. */
  says: string;
}

export interface Calibration {
  /** Null when there are not yet 30 payers: the report says so rather than guessing. */
  ready: boolean;
  payers: number;
  users: number;
  threshold: number;
  /** The share of payers who crossed 60 before paying. */
  recall: number | null;
  /** The share of users above 60 who went on to pay. */
  precision: number | null;
  lifts: SignalLift[];
  suggestions: WeightSuggestion[];
  /** The report, as lines, for the simulator and the founder's screen. */
  lines: string[];
}

/**
 * A signal needs this many users on each side before its lift is reported.
 *
 * Without it, a signal two people have would show a lift of 12× and generate a
 * confident suggestion to double its weight.
 */
export const MIN_PER_SIDE_FOR_LIFT = 10;

/**
 * How far a lift has to be from the points before a change is suggested.
 *
 * A signal worth 30 points that converts barely better than its absence, or one worth
 * 5 that doubles conversion, is worth raising. Small disagreements are noise, and
 * suggesting a change for every one of them would teach the founder to ignore all of
 * them.
 */
export const LIFT_DISAGREEMENT_RATIO = 2;

export function calibrate(
  users: readonly CalibrationUser[],
  now: Date,
  threshold = HIGH_INTENT_THRESHOLD,
): Calibration {
  const payers = users.filter((user) => user.paidAt !== null);
  const ready = payers.length >= MIN_PAYERS_FOR_CALIBRATION;

  /*
   * Recall counts crossing 60 BEFORE paying, not ever.
   *
   * Someone whose score crossed 60 only because the payment itself scored points
   * would count as a success for a prediction that was never made.
   */
  const predictedPayers = payers.filter(
    (user) => user.firstHighAt !== null && user.paidAt !== null && user.firstHighAt <= user.paidAt,
  );
  const recall = payers.length === 0 ? null : predictedPayers.length / payers.length;

  const aboveThreshold = users.filter((user) => user.peakScore >= threshold);
  const precision =
    aboveThreshold.length === 0
      ? null
      : aboveThreshold.filter((user) => user.paidAt !== null).length / aboveThreshold.length;

  const lifts = INTENT_POINTS.map((definition) => liftOf(definition.key, users));
  const suggestions = lifts
    .map((lift) => lift.suggestion)
    .filter((suggestion): suggestion is WeightSuggestion => suggestion !== null);

  return {
    ready,
    payers: payers.length,
    users: users.length,
    threshold,
    recall,
    precision,
    lifts,
    suggestions,
    lines: report(
      {
        ready,
        payers: payers.length,
        users: users.length,
        threshold,
        recall,
        precision,
        lifts,
        suggestions,
      },
      now,
    ),
  };
}

function liftOf(key: IntentSignalKey, users: readonly CalibrationUser[]): SignalLift {
  const definition = INTENT_POINTS_BY_KEY.get(key)!;
  const withSignal = users.filter((user) => user.signals.has(key));
  const withoutSignal = users.filter((user) => !user.signals.has(key));

  const withRate =
    withSignal.length === 0
      ? null
      : withSignal.filter((u) => u.paidAt !== null).length / withSignal.length;
  const withoutRate =
    withoutSignal.length === 0
      ? null
      : withoutSignal.filter((u) => u.paidAt !== null).length / withoutSignal.length;

  const comparable =
    withSignal.length >= MIN_PER_SIDE_FOR_LIFT && withoutSignal.length >= MIN_PER_SIDE_FOR_LIFT;

  const lift =
    comparable && withRate !== null && withoutRate !== null && withoutRate > 0
      ? withRate / withoutRate
      : null;

  return {
    key,
    points: definition.points,
    withRate,
    withoutRate,
    lift,
    withUsers: withSignal.length,
    withoutUsers: withoutSignal.length,
    suggestion: comparable ? suggest(key, definition.points, lift) : null,
  };
}

/**
 * Suggests a weight, and only suggests.
 *
 * The suggested number is deliberately coarse — a step towards what the data says,
 * not a fitted coefficient. The brief rules out a fitted per-product model, and a
 * number with two decimal places would imply a confidence this does not have.
 */
function suggest(
  key: IntentSignalKey,
  currentPoints: number,
  lift: number | null,
): WeightSuggestion | null {
  if (lift === null) return null;
  // A negative-points signal is a different kind of claim; leave it to a human.
  if (currentPoints <= 0) return null;

  if (lift >= LIFT_DISAGREEMENT_RATIO && currentPoints <= 10) {
    return {
      key,
      currentPoints,
      suggestedPoints: Math.min(30, currentPoints * 2),
      says: `People with this signal pay ${lift.toFixed(1)} times as often as people without it, which is more than its ${currentPoints} points suggest. Raising it to ${Math.min(30, currentPoints * 2)} would match what your users actually do.`,
    };
  }

  if (lift <= 1 / LIFT_DISAGREEMENT_RATIO && currentPoints >= 10) {
    return {
      key,
      currentPoints,
      suggestedPoints: Math.max(5, Math.round(currentPoints / 2)),
      says: `People with this signal pay LESS often than people without it, which its ${currentPoints} points do not reflect. Lowering it to ${Math.max(5, Math.round(currentPoints / 2))} would match what your users actually do.`,
    };
  }

  // A high-value signal that barely beats its absence.
  if (lift < 1.2 && currentPoints >= 20) {
    return {
      key,
      currentPoints,
      suggestedPoints: Math.max(10, Math.round(currentPoints / 2)),
      says: `This is one of your biggest signals at ${currentPoints} points, but people who do it pay only ${lift.toFixed(1)} times as often as people who do not. It may be worth less than it looks.`,
    };
  }

  return null;
}

type ReportInput = Omit<Calibration, 'lines'>;

/** The printed report (brief §11: the calibration job prints recall, precision and lift). */
function report(input: ReportInput, now: Date): string[] {
  const pct = (value: number | null) => (value === null ? '   —' : `${(value * 100).toFixed(1)}%`);
  const lines: string[] = [];

  lines.push(`calibration at ${now.toISOString()}`);
  lines.push(`  users ${input.users}, payers ${input.payers}`);

  if (!input.ready) {
    lines.push(
      `  not enough payers yet: ${input.payers} of the ${MIN_PAYERS_FOR_CALIBRATION} needed, so nothing below is reported as fact.`,
    );
  }

  lines.push(`  threshold ${input.threshold}`);
  lines.push(
    `  recall    ${pct(input.recall)}  (payers who crossed ${input.threshold} before paying)`,
  );
  lines.push(`  precision ${pct(input.precision)}  (users above ${input.threshold} who paid)`);
  lines.push('  signal lift (conversion with the signal against without):');

  for (const lift of input.lifts) {
    const liftText = lift.lift === null ? '    —' : `${lift.lift.toFixed(2)}×`;
    lines.push(
      `    ${lift.key.padEnd(28)} ${String(lift.points).padStart(3)}pts  ${pct(lift.withRate)} vs ${pct(lift.withoutRate)}  ${liftText}  (${lift.withUsers}/${lift.withoutUsers})`,
    );
  }

  if (input.suggestions.length === 0) {
    lines.push('  no weight changes suggested.');
  } else {
    lines.push(
      `  ${input.suggestions.length} weight change(s) to approve — never applied automatically:`,
    );
    for (const suggestion of input.suggestions) {
      lines.push(
        `    ${suggestion.key}: ${suggestion.currentPoints} → ${suggestion.suggestedPoints}`,
      );
      lines.push(`      ${suggestion.says}`);
    }
  }

  return lines;
}

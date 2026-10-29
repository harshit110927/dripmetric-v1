import { withProject, currentProject, type ScopedDb } from '@dripmetric/db';
import {
  bandOf,
  calibrate,
  didntPayGroups,
  HIGH_INTENT_THRESHOLD,
  INTENT_SIGNAL_KEYS,
  potentialRevenue,
  replayPeak,
  scoreIntent,
  type Calibration,
  type CalibrationUser,
  type IntentBand,
  type IntentSignalKey,
  type PotentialRevenue,
} from '@dripmetric/engine';
import { loadIntentFacts, type ProjectIntentContext, type UserIntentFacts } from './facts.js';

/**
 * Storing and reading intent state (brief §8.2, brief §4's `intent_state`).
 *
 * The score itself is never stored: it decays, so a stored copy would be wrong a
 * minute later. What is stored is the facts behind it, the base points and the peak —
 * and the peak is replayed from the facts' own timestamps, so it is rebuildable
 * (CLAUDE.md rule 10).
 */

/** Reads the project settings the fit points and the window need. */
export async function intentContextFor(db: ScopedDb): Promise<
  ProjectIntentContext & {
    windowDays: number;
    listPrice: { amount: number | null; currency: string; interval: 'month' | 'year' };
  }
> {
  const project = await currentProject(db);
  const settings = project.settings;

  return {
    timezone: project.timezone,
    workingHours: settings.workingHours,
    brandTerms: settings.brandTerms,
    productKind: settings.productKind,
    mobileFirst: settings.mobileFirst,
    // TODO(decision-7): W is this per-project setting and nothing may derive it from
    // the trial length — settled decision 7 says not to build trial-aware logic.
    windowDays: settings.didntPayWindowDays,
    listPrice: {
      amount: settings.listPriceAmount,
      currency: settings.listPriceCurrency,
      interval: settings.listPriceInterval,
    },
  };
}

/**
 * Refreshes every user's intent state for one project.
 *
 * Idempotent by construction: the facts are derived from events, the base points from
 * the facts, and the peak replayed from the facts' timestamps. Running it twice over
 * the same events writes the same rows — which is M7's "replaying events twice gives
 * identical scores" exit check.
 */
export async function refreshIntentState(db: ScopedDb, now: Date): Promise<number> {
  const context = await intentContextFor(db);
  const { users } = await loadIntentFacts(db, context, now);
  if (users.length === 0) return 0;

  const rows = users.map((user) => {
    const score = scoreIntent(user.facts, now);
    const peak = replayPeak(user.timeline, user.facts, HIGH_INTENT_THRESHOLD);
    return { user, score, peak };
  });

  await db.exec(
    `INSERT INTO intent_state (
       project_id, user_key, last_event_at,
       checkout_started, activated, plan_limit_or_paywall, pricing_viewed,
       pricing_deliberation, invite_sent, integration_or_import, core_action_early,
       active_three_of_seven, fast_activation, payment_method_before_trial_end,
       sales_contact_requested, disposable_email, fit, price_objection,
       base_points, peak_score, peak_at, first_high_at, computed_at
     )
     SELECT $1, s.user_key, s.last_event_at,
            s.checkout_started, s.activated, s.plan_limit_or_paywall, s.pricing_viewed,
            s.pricing_deliberation, s.invite_sent, s.integration_or_import,
            s.core_action_early, s.active_three_of_seven, s.fast_activation,
            s.payment_method_before_trial_end, s.sales_contact_requested,
            s.disposable_email, s.fit, s.price_objection,
            s.base_points, s.peak_score, s.peak_at, s.first_high_at, $2
       FROM unnest(
              $3::int[], $4::timestamptz[],
              $5::boolean[], $6::boolean[], $7::boolean[], $8::boolean[],
              $9::boolean[], $10::boolean[], $11::boolean[], $12::boolean[],
              $13::boolean[], $14::boolean[], $15::boolean[],
              $16::boolean[], $17::boolean[], $18::jsonb[], $19::boolean[],
              $20::int[], $21::int[], $22::timestamptz[], $23::timestamptz[]
            ) AS s(user_key, last_event_at,
                   checkout_started, activated, plan_limit_or_paywall, pricing_viewed,
                   pricing_deliberation, invite_sent, integration_or_import,
                   core_action_early, active_three_of_seven, fast_activation,
                   payment_method_before_trial_end, sales_contact_requested,
                   disposable_email, fit, price_objection,
                   base_points, peak_score, peak_at, first_high_at)
     ON CONFLICT (project_id, user_key) DO UPDATE SET
       last_event_at = EXCLUDED.last_event_at,
       checkout_started = EXCLUDED.checkout_started,
       activated = EXCLUDED.activated,
       plan_limit_or_paywall = EXCLUDED.plan_limit_or_paywall,
       pricing_viewed = EXCLUDED.pricing_viewed,
       pricing_deliberation = EXCLUDED.pricing_deliberation,
       invite_sent = EXCLUDED.invite_sent,
       integration_or_import = EXCLUDED.integration_or_import,
       core_action_early = EXCLUDED.core_action_early,
       active_three_of_seven = EXCLUDED.active_three_of_seven,
       fast_activation = EXCLUDED.fast_activation,
       payment_method_before_trial_end = EXCLUDED.payment_method_before_trial_end,
       sales_contact_requested = EXCLUDED.sales_contact_requested,
       disposable_email = EXCLUDED.disposable_email,
       fit = EXCLUDED.fit,
       price_objection = EXCLUDED.price_objection,
       base_points = EXCLUDED.base_points,
       /*
        * The peak and the first crossing are replayed, so they are simply written.
        *
        * GREATEST against the stored value would look safer and be worse: it would
        * make a correction impossible. If a mapping changes and a signal turns out
        * never to have applied, the peak has to come DOWN, and a monotonic column
        * would keep the old number for ever with nothing to explain it.
        */
       peak_score = EXCLUDED.peak_score,
       peak_at = EXCLUDED.peak_at,
       first_high_at = EXCLUDED.first_high_at,
       computed_at = EXCLUDED.computed_at`,
    [
      db.projectId,
      now,
      rows.map((r) => r.user.userKey),
      rows.map((r) => r.user.facts.lastEventAt),
      rows.map((r) => r.user.facts.checkoutStarted),
      rows.map((r) => r.user.facts.activated),
      rows.map((r) => r.user.facts.planLimitOrPaywall),
      rows.map((r) => r.user.facts.pricingViewed),
      rows.map((r) => r.user.facts.pricingDeliberation),
      rows.map((r) => r.user.facts.inviteSent),
      rows.map((r) => r.user.facts.integrationOrImport),
      rows.map((r) => r.user.facts.coreActionEarly),
      rows.map((r) => r.user.facts.activeThreeOfSeven),
      rows.map((r) => r.user.facts.fastActivation),
      rows.map((r) => r.user.facts.paymentMethodBeforeTrialEnd),
      rows.map((r) => r.user.facts.salesContactRequested),
      rows.map((r) => r.user.facts.disposableEmail),
      rows.map((r) => JSON.stringify(r.user.facts.fit)),
      rows.map((r) => r.user.facts.priceObjection),
      rows.map((r) => r.score.basePoints),
      rows.map((r) => r.peak.peakScore),
      rows.map((r) => r.peak.peakAt),
      rows.map((r) => r.peak.firstHighAt),
    ],
  );

  return rows.length;
}

export interface IntentSummary {
  computedAt: Date;
  /** How many users sit in each band right now, after decay. */
  bands: Record<IntentBand, number>;
  users: number;
  /** Brief §9: "high intent that didn't pay (past the window, and still inside it)". */
  didntPay: {
    pastWindow: number;
    insideWindow: number;
    windowDays: number;
    /** Null until the paid event arrives (settled decision 9). */
    potentialRevenue: PotentialRevenue | null;
    /** The plain note shown while revenue is off. */
    note: string | null;
  };
  /** Set when a founder has signals saying "the price is the problem". */
  priceObjections: number;
}

/**
 * The intent module's numbers (brief §9's Intent module).
 *
 * The bands are computed from the stored facts and `now`, not read from a column:
 * the score decays, so a stored band would drift out of date between refreshes and a
 * founder refreshing the page would see a number that does not move.
 */
export async function intentSummary(db: ScopedDb, now: Date): Promise<IntentSummary> {
  const context = await intentContextFor(db);
  const paidEventSeen = await hasPaidEvent(db);

  const rows = await db.query<{
    user_key: number;
    peak_score: number;
    first_high_at: Date | null;
    paid_at: Date | null;
    price_objection: boolean;
    last_event_at: Date | null;
    base_points: number;
  }>(
    `SELECT s.user_key, s.peak_score, s.first_high_at, u.paid_at, s.price_objection,
            s.last_event_at, s.base_points
       FROM intent_state s
       JOIN end_users u ON u.project_id = s.project_id AND u.user_key = s.user_key
      WHERE s.project_id = $1 AND u.deleted_at IS NULL AND NOT u.internal`,
    [db.projectId],
  );

  const bands: Record<IntentBand, number> = { low: 0, warm: 0, high: 0 };
  for (const row of rows) {
    // The same decay the engine applies, from the stored base points.
    const quietDays =
      row.last_event_at === null
        ? null
        : Math.max(0, (now.getTime() - row.last_event_at.getTime()) / 86_400_000);
    const score =
      quietDays === null ? 0 : Math.round(row.base_points * Math.pow(2, -quietDays / 7));
    bands[bandOf(score)] += 1;
  }

  const groups = didntPayGroups(
    rows.map((row) => ({
      userKey: row.user_key,
      firstHighAt: row.first_high_at,
      peakScore: row.peak_score,
      paidAt: row.paid_at,
    })),
    now,
    context.windowDays,
  );

  return {
    computedAt: now,
    bands,
    users: rows.length,
    didntPay: {
      pastWindow: groups.pastWindow.length,
      insideWindow: groups.insideWindow.length,
      windowDays: groups.windowDays,
      potentialRevenue: paidEventSeen
        ? potentialRevenue(
            groups.pastWindow.length,
            context.listPrice.amount,
            context.listPrice.currency,
            context.listPrice.interval,
          )
        : null,
      note: paidEventSeen
        ? null
        : 'We can see who looks ready to buy, but not who paid, so there is no money figure yet. Send "Subscription Started" from your server, or map one of your own events to it.',
    },
    priceObjections: rows.filter((row) => row.price_objection).length,
  };
}

/** Settled decision 9: no paid event, no revenue numbers. */
async function hasPaidEvent(db: ScopedDb): Promise<boolean> {
  const row = await db.maybeOne(
    `SELECT 1 FROM event_names
      WHERE project_id = $1 AND canonical = 'Subscription Started'
        AND status = 'confirmed' AND event_count > 0
      LIMIT 1`,
    [db.projectId],
  );
  return row !== null;
}

/**
 * The calibration job (brief §8.2).
 *
 * It computes and suggests; it never writes a weight. The suggestions are stored on
 * `intent_config` for the founder to approve, and the report is returned so the
 * simulator and the worker log can print it.
 */
export async function runCalibration(db: ScopedDb, now: Date): Promise<Calibration> {
  const rows = await db.query<
    {
      user_key: number;
      peak_score: number;
      first_high_at: Date | null;
      paid_at: Date | null;
    } & Record<string, unknown>
  >(
    `SELECT s.*, u.paid_at
       FROM intent_state s
       JOIN end_users u ON u.project_id = s.project_id AND u.user_key = s.user_key
      WHERE s.project_id = $1 AND u.deleted_at IS NULL AND NOT u.internal`,
    [db.projectId],
  );

  const users: CalibrationUser[] = rows.map((row) => ({
    userKey: row.user_key,
    peakScore: row.peak_score,
    firstHighAt: row.first_high_at,
    paidAt: row.paid_at,
    signals: signalsOf(row),
  }));

  const calibration = calibrate(users, now);

  await db.exec(
    `INSERT INTO intent_config (project_id, calibration, calibrated_at)
     VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (project_id) DO UPDATE SET
       calibration = EXCLUDED.calibration,
       calibrated_at = EXCLUDED.calibrated_at,
       updated_at = EXCLUDED.calibrated_at`,
    [
      db.projectId,
      JSON.stringify({
        ready: calibration.ready,
        payers: calibration.payers,
        users: calibration.users,
        recall: calibration.recall,
        precision: calibration.precision,
        lifts: calibration.lifts,
        suggestions: calibration.suggestions,
      }),
      now,
    ],
  );

  return calibration;
}

/** Which signals were ever true for this user, from the stored columns. */
const SIGNAL_COLUMNS: Record<IntentSignalKey, string> = {
  checkoutStarted: 'checkout_started',
  activated: 'activated',
  planLimitOrPaywall: 'plan_limit_or_paywall',
  pricingViewed: 'pricing_viewed',
  pricingDeliberation: 'pricing_deliberation',
  inviteSent: 'invite_sent',
  integrationOrImport: 'integration_or_import',
  coreActionEarly: 'core_action_early',
  activeThreeOfSeven: 'active_three_of_seven',
  fastActivation: 'fast_activation',
  paymentMethodBeforeTrialEnd: 'payment_method_before_trial_end',
  salesContactRequested: 'sales_contact_requested',
  fitPoints: 'fit',
  disposableEmail: 'disposable_email',
};

function signalsOf(row: Record<string, unknown>): Set<IntentSignalKey> {
  const signals = new Set<IntentSignalKey>();
  for (const key of INTENT_SIGNAL_KEYS) {
    const column = SIGNAL_COLUMNS[key];
    if (key === 'fitPoints') {
      const fit = row['fit'] as Record<string, boolean> | null;
      if (fit && Object.values(fit).some(Boolean)) signals.add(key);
      continue;
    }
    if (row[column] === true) signals.add(key);
  }
  return signals;
}

/**
 * Adds the intent section to the day's summary (brief §4's `daily_summaries`).
 *
 * Merged into the same row the funnel wrote, with `||`, which is why that payload is
 * one JSONB document: the summaries are kept for ever and the raw events are not, so
 * every engine's numbers have to land in the row that survives.
 */
export async function writeIntentSummary(db: ScopedDb, now: Date): Promise<void> {
  const summary = await intentSummary(db, now);
  await db.exec(
    `INSERT INTO daily_summaries (project_id, day, payload, computed_at)
     VALUES ($1, $2::date, $3::jsonb, $4)
     ON CONFLICT (project_id, day) DO UPDATE SET
       payload = daily_summaries.payload || EXCLUDED.payload,
       computed_at = EXCLUDED.computed_at`,
    [db.projectId, now.toISOString().slice(0, 10), JSON.stringify({ intent: summary }), now],
  );
}

/**
 * The whole intent pass for one project, as the worker runs it.
 *
 * It refreshes the project rather than one person. The per-person follow-up the
 * ingest pipeline already collects (`recompute-intent`) stays unconnected until the
 * dashboard needs a score to be fresh within seconds rather than within the hour —
 * one project-wide pass is a single query and a single write, where a thousand
 * per-person passes are two thousand.
 */
export async function runIntentRefresh(projectId: number, now: Date): Promise<number> {
  return withProject(projectId, (db) => refreshIntentState(db, now), { worker: true });
}

/** The nightly intent pass: refresh, summarise, calibrate. */
export async function runIntentDaily(projectId: number, now: Date): Promise<Calibration> {
  return withProject(
    projectId,
    async (db) => {
      await refreshIntentState(db, now);
      await writeIntentSummary(db, now);
      return runCalibration(db, now);
    },
    { worker: true },
  );
}

export type { UserIntentFacts };

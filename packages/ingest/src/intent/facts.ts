import type { ScopedDb } from '@dripmetric/db';
import { isBrandSearch, isReviewSite } from '@dripmetric/catalog';
import {
  ACTIVATIONS_FOR_MEDIAN_TTV,
  ACTIVE_DAYS_REQUIRED,
  ACTIVE_DAYS_WINDOW,
  CORE_ACTION_EARLY_DAYS,
  CORE_ACTION_EARLY_COUNT,
  classifyPricingView,
  emptyFacts,
  inWorkingHours,
  internalMedian,
  PRICE_OBJECTION_DISMISSALS,
  pricingThresholds,
  type FitPointKey,
  type IntentFacts,
  type IntentSignalKey,
  type PricingThresholds,
  type SignalMoment,
  type PricingViewFact,
  type WorkingHours,
} from '@dripmetric/engine';

/**
 * Deriving every intent fact from stored events (brief §8.2).
 *
 * "Store the facts the score needs so it can be recomputed." This is the derivation:
 * raw events in, one `IntentFacts` per person out. It is pure SQL plus the engine's
 * own pure rules, so running it twice over the same events gives the same facts —
 * which is what makes "replaying events twice gives identical scores" true rather
 * than hoped for (M7's exit check, CLAUDE.md rule 10).
 */

/** The canonical names each signal reads. Named here, never inline (rule 11). */
export const INTENT_EVENTS = {
  checkoutStarted: 'Checkout Started',
  planLimitReached: 'Plan Limit Reached',
  upgradePromptViewed: 'Upgrade Prompt Viewed',
  upgradePromptDismissed: 'Upgrade Prompt Dismissed',
  pricingViewed: 'Pricing Viewed',
  pageLeft: 'Page Left',
  inviteSent: 'Invite Sent',
  integrationConnected: 'Integration Connected',
  dataImported: 'Data Imported',
  coreAction: 'Core Action',
  paymentMethodAdded: 'Payment Method Added',
  salesContactRequested: 'Sales Contact Requested',
  planSelected: 'Plan Selected',
} as const;

/**
 * What "they compared the plans" can actually be observed from.
 *
 * Brief §8.2 lists "the annual toggle, a plan click or the FAQ opened" as
 * deliberation. Of those three, only the plan click has an event in the settled
 * catalog — `Plan Selected` (Appendix A, settled 8 Oct 2026, decision 16). The
 * annual toggle and the FAQ have no catalog event, and the catalog is closed, so
 * they are not observable unless a founder sends and maps their own event.
 *
 * Deliberation therefore rests on the plan click, on active time above the
 * product's own median, and on a second proper visit within a week — all three of
 * which this product's data does carry. `classifyPricingView` keeps the toggle and
 * FAQ inputs so a founder who does map such an event gets them for free.
 */
export const DELIBERATION_WINDOW_SECONDS = 30 * 60;

/**
 * Brief §8.2: Checkout Started is worth 30 "not for a checkout that only starts a
 * card-up-front trial".
 *
 * The `type` property is brief §12's flagged assumption: a checkout that starts a
 * trial sends `type: "trial"`. Anything else — including a missing `type` — is a real
 * checkout, because the common case must not need the founder to send extra data.
 */
export const TRIAL_CHECKOUT_TYPE = 'trial';

export interface ProjectIntentContext {
  timezone: string;
  workingHours: WorkingHours;
  brandTerms: readonly string[];
  /** Desktop-at-signup is a fit point "for team products; off for mobile-first". */
  productKind: string;
  mobileFirst: boolean;
}

export interface UserIntentFacts {
  userKey: number;
  facts: IntentFacts;
  /** Carried so the caller can split "didn't pay" without a second query. */
  paidAt: Date | null;
  signedUpAt: Date | null;
  /** The pricing readings behind the two pricing signals, for a timeline. */
  pricing: { pattern: string; says: string }[];
  /**
   * Every monotonic signal with the moment it became true, oldest first.
   *
   * `activeThreeOfSeven` is deliberately absent: it is a statement about the present
   * ("active on 3 of the last 7 days"), so including it in a historical replay would
   * make the date someone crossed 60 last March depend on whether they logged in
   * this week.
   */
  timeline: SignalMoment[];
}

interface UserRow {
  user_key: number;
  last_event_at: Date | null;
  signed_up_at: Date | null;
  activated_at: Date | null;
  paid_at: Date | null;
  trial_started_at: Date | null;
  trial_ends_at: Date | null;
  card_required: boolean | null;
  email_type: string | null;
  visits_before_signup: number;
  first_touch: { referrerDomain?: string; utmTerm?: string } | null;
  /** The device of their earliest session: "desktop at signup". */
  signup_device: string | null;
  /*
   * When each signal FIRST became true, not whether it is.
   *
   * `first_high_at` has to be derivable from events (CLAUDE.md rule 10) — the
   * calibration's recall asks whether someone crossed 60 *before* paying, and a
   * timestamp stamped whenever a refresh happened to run could not answer that. With
   * the first-occurrence times, the crossing is replayed instead of guessed.
   */
  checkout_started_at: Date | null;
  plan_limit_or_paywall_at: Date | null;
  invite_sent_at: Date | null;
  integration_or_import_at: Date | null;
  sales_contact_requested_at: Date | null;
  payment_method_before_trial_end_at: Date | null;
  core_action_early_at: Date | null;
  dismissals: number;
  active_days_recent: number;
  time_to_value_seconds: string | null;
}

/**
 * One query per project for the parts SQL does better than JavaScript: existence of
 * an event, counts inside a window, the earliest session's device.
 *
 * `now` is a parameter, including for the rolling "last 7 days" window, so a score
 * can be recomputed as of a past moment and come out the same (rule 9).
 */
async function loadUserRows(db: ScopedDb, now: Date): Promise<UserRow[]> {
  return db.query<UserRow>(
    `WITH named AS (
       SELECT e.user_key, e.occurred_at, e.props, n.canonical
         FROM events e
         JOIN event_names n ON n.project_id = e.project_id AND n.id = e.name_id
        WHERE e.project_id = $1 AND e.user_key IS NOT NULL AND n.canonical IS NOT NULL
     ), signup_device AS (
       SELECT DISTINCT ON (s.user_key) s.user_key, s.device_type
         FROM sessions s
        WHERE s.project_id = $1 AND s.user_key IS NOT NULL
        ORDER BY s.user_key, s.started_at
     ), core_action_third AS (
       /*
        * When the THIRD early core action happened, not the last one.
        *
        * "Core Action 3 or more times in the first 14 days" becomes true at the
        * third, and that is the moment its +10 joins the score. Using the latest one
        * would move the signal's start date every time they used the product again.
        */
       SELECT user_key, occurred_at AS at
         FROM (
           SELECT e.user_key, e.occurred_at,
                  row_number() OVER (PARTITION BY e.user_key ORDER BY e.occurred_at) AS rn
             FROM named e
             JOIN end_users eu ON eu.project_id = $1 AND eu.user_key = e.user_key
            WHERE e.canonical = $12
              AND eu.signed_up_at IS NOT NULL
              AND e.occurred_at >= eu.signed_up_at
              AND e.occurred_at < eu.signed_up_at + make_interval(days => $13)
         ) ranked
        WHERE rn = $16
     )
     SELECT u.user_key,
            u.last_event_at,
            u.signed_up_at,
            u.activated_at,
            u.paid_at,
            u.trial_started_at,
            u.trial_ends_at,
            u.card_required,
            u.email_type,
            u.visits_before_signup,
            u.first_touch,
            d.device_type AS signup_device,

            -- A checkout that only starts a card-up-front trial is not intent to buy.
            min(e.occurred_at) FILTER (
              WHERE e.canonical = $2 AND coalesce(e.props->>'type', '') <> $3
            ) AS checkout_started_at,
            -- Shared row: a plan limit OR an upgrade prompt at a paywall, once.
            min(e.occurred_at) FILTER (
              WHERE e.canonical = $4
                 OR (e.canonical = $5 AND coalesce(e.props->>'paywall', 'false') NOT IN ('false', ''))
            ) AS plan_limit_or_paywall_at,
            min(e.occurred_at) FILTER (WHERE e.canonical = $6) AS invite_sent_at,
            -- Shared row: an integration OR an import, once.
            min(e.occurred_at) FILTER (WHERE e.canonical IN ($7, $8)) AS integration_or_import_at,
            min(e.occurred_at) FILTER (WHERE e.canonical = $9) AS sales_contact_requested_at,
            -- A card added before the trial ended, on a trial that began without one.
            min(e.occurred_at) FILTER (
              WHERE e.canonical = $10
                AND u.trial_started_at IS NOT NULL
                AND coalesce(u.card_required, false) = false
                AND (u.trial_ends_at IS NULL OR e.occurred_at < u.trial_ends_at)
            ) AS payment_method_before_trial_end_at,

            count(*) FILTER (WHERE e.canonical = $11)::int AS dismissals,
            third.at AS core_action_early_at,
            count(DISTINCT e.occurred_at::date) FILTER (
              WHERE e.occurred_at > $14::timestamptz - make_interval(days => $15)
                AND e.occurred_at <= $14::timestamptz
            )::int AS active_days_recent,
            CASE
              WHEN u.signed_up_at IS NOT NULL AND u.activated_at IS NOT NULL
              THEN extract(epoch FROM u.activated_at - u.signed_up_at)::text
            END AS time_to_value_seconds

       FROM end_users u
       LEFT JOIN named e ON e.user_key = u.user_key
       LEFT JOIN signup_device d ON d.user_key = u.user_key
       LEFT JOIN core_action_third third ON third.user_key = u.user_key
      WHERE u.project_id = $1
        AND u.deleted_at IS NULL
        AND NOT u.internal
        AND NOT u.opted_out
      GROUP BY u.user_key, u.last_event_at, u.signed_up_at, u.activated_at, u.paid_at,
               u.trial_started_at, u.trial_ends_at, u.card_required, u.email_type,
               u.visits_before_signup, u.first_touch, d.device_type, third.at`,
    [
      db.projectId,
      INTENT_EVENTS.checkoutStarted,
      TRIAL_CHECKOUT_TYPE,
      INTENT_EVENTS.planLimitReached,
      INTENT_EVENTS.upgradePromptViewed,
      INTENT_EVENTS.inviteSent,
      INTENT_EVENTS.integrationConnected,
      INTENT_EVENTS.dataImported,
      INTENT_EVENTS.salesContactRequested,
      INTENT_EVENTS.paymentMethodAdded,
      INTENT_EVENTS.upgradePromptDismissed,
      INTENT_EVENTS.coreAction,
      CORE_ACTION_EARLY_DAYS,
      now,
      ACTIVE_DAYS_WINDOW,
      CORE_ACTION_EARLY_COUNT,
    ],
  );
}

interface PricingRow {
  /** Null for a visitor who never identified: they count in rates, not dollars. */
  user_key: number | null;
  visitor: number;
  occurred_at: Date;
  session_id: string | null;
  active_seconds: string | null;
  page_speed_ms: string | null;
  toggled: boolean;
  clicked_plan: boolean;
  opened_faq: boolean;
  session_ended_at: Date | null;
  /** The session's context, for the quick-exit rate's four splits (brief §8.3). */
  source: string | null;
  device: string | null;
  country: string | null;
  trial_day: string | null;
}

/**
 * The pricing views, with the facts the four patterns need.
 *
 * The active time and the page speed arrive on `Page Left`, not on the pricing view
 * itself — the browser cannot know how long someone stayed until they go. So the two
 * are matched by session and path, which is also why `Page Left` is stored for key
 * pages: pricing is one (brief §4's volume guards).
 */
export async function loadPricingRows(db: ScopedDb): Promise<PricingRow[]> {
  return db.query<PricingRow>(
    `WITH pricing_paths AS (
       SELECT DISTINCT p.id
         FROM paths p
         LEFT JOIN url_rules r
           ON r.project_id = p.project_id
          AND r.canonical = $2
          AND (p.path = r.pattern OR (r.pattern LIKE '%*' AND p.path LIKE replace(r.pattern, '*', '%')))
        WHERE p.project_id = $1 AND r.id IS NOT NULL
     ), candidates AS (
       /*
        * Anonymous visitors are included.
        *
        * Brief §8.2: "Anonymous visitors count in rates, not dollars." The
        * quick-exit RATE is one of the brief's headline numbers, and a rate whose
        * denominator counted everyone while its numerator counted only signed-up
        * users would read lower the more anonymous traffic a founder had.
        */
       SELECT e.user_key,
              coalesce(e.user_key, -e.anon_key) AS visitor,
              e.occurred_at, e.session_id, e.path_id, e.props,
              (e.path_id IN (SELECT id FROM pricing_paths)) AS on_pricing_page
         FROM events e
         JOIN event_names n ON n.project_id = e.project_id AND n.id = e.name_id
        WHERE e.project_id = $1
          AND coalesce(e.user_key, e.anon_key) IS NOT NULL
          AND (n.canonical = $2 OR e.path_id IN (SELECT id FROM pricing_paths))
          AND n.canonical IN ($2, 'Page Viewed')
     ), views AS (
       /*
        * One row per pricing VIEW, not per event describing it.
        *
        * A single visit to the pricing page usually arrives twice: as a page view of
        * a path a URL rule maps to Pricing Viewed, and as a Pricing Viewed event the
        * founder sends by hand. Counting both doubled the denominator of the
        * quick-exit rate AND made every visitor's first visit look like their
        * second — so nothing could ever be a "first-ever pricing view", and the rate
        * read 0 of 406 on data where a third of visitors glance and leave.
        *
        * The page view wins where there is one, because it carries the path and can
        * therefore be matched to the Page Left that knows how long they stayed. A
        * project that only sends the event keeps its views, with no active time,
        * which is honest: without a Page Left on the page nobody told us.
        */
       SELECT user_key, visitor, occurred_at, session_id, path_id, props
         FROM candidates
        WHERE on_pricing_page
       UNION ALL
       SELECT user_key, visitor, occurred_at, session_id, path_id, props
         FROM candidates c
        WHERE NOT c.on_pricing_page
          AND NOT EXISTS (
            SELECT 1 FROM candidates p
             WHERE p.on_pricing_page
               AND p.visitor = c.visitor
               AND p.session_id IS NOT DISTINCT FROM c.session_id
          )
     ), leaves AS (
       /*
        * The active time and the page speed arrive on the Page Left event, matched
        * to the view by session and path. They cannot be on the view itself: a
        * browser does not know how long someone stayed until they go (brief §6).
        */
       SELECT e.session_id, e.path_id,
              max((e.props->>'activeSeconds')::numeric) AS active_seconds,
              min((e.props->>'pageSpeedMs')::numeric) AS page_speed_ms
         FROM events e
         JOIN event_names n ON n.project_id = e.project_id AND n.id = e.name_id
        WHERE e.project_id = $1 AND n.canonical = $3
        GROUP BY e.session_id, e.path_id
     ), plan_clicks AS (
       -- A plan click: the one deliberation interaction the settled catalog has.
       SELECT DISTINCT e.session_id
         FROM events e
         JOIN event_names n ON n.project_id = e.project_id AND n.id = e.name_id
        WHERE e.project_id = $1 AND n.canonical = $4
     )
     SELECT v.user_key,
            v.visitor,
            v.occurred_at,
            v.session_id::text AS session_id,
            l.active_seconds::text AS active_seconds,
            l.page_speed_ms::text AS page_speed_ms,
            false AS toggled,
            (c.session_id IS NOT NULL) AS clicked_plan,
            false AS opened_faq,
            s.ended_at AS session_ended_at,
            coalesce(
              CASE WHEN s.paid_click THEN 'paid: ' || coalesce(s.paid_network, 'unknown') END,
              s.utm_source, s.referrer_domain, 'direct'
            ) AS source,
            coalesce(s.device_type, 'unknown') AS device,
            coalesce(s.country, 'unknown') AS country,
            CASE
              WHEN u.trial_started_at IS NULL THEN 'no trial'
              ELSE 'day ' || floor(
                extract(epoch FROM v.occurred_at - u.trial_started_at) / 86400
              )::text
            END AS trial_day
       FROM views v
       LEFT JOIN leaves l ON l.session_id = v.session_id AND l.path_id = v.path_id
       LEFT JOIN plan_clicks c ON c.session_id = v.session_id
       LEFT JOIN sessions s ON s.project_id = $1 AND s.id = v.session_id
       LEFT JOIN end_users u ON u.project_id = $1 AND u.user_key = v.user_key
      ORDER BY v.visitor, v.occurred_at`,
    [db.projectId, INTENT_EVENTS.pricingViewed, INTENT_EVENTS.pageLeft, INTENT_EVENTS.planSelected],
  );
}

/**
 * Turns the rows into the engine's pricing facts, in order, per visitor.
 *
 * Keyed by VISITOR rather than by user, so an anonymous visitor's second view is
 * their second view. Keying on the user would have made every anonymous view a
 * first-ever one, and "first-ever pricing view" is half the quick-exit rule.
 */
function pricingViewsByUser(rows: readonly PricingRow[]): Map<number, PricingViewFact[]> {
  const byUser = new Map<number, PricingViewFact[]>();

  for (const row of rows) {
    const list = byUser.get(row.visitor) ?? [];
    const previous = list[list.length - 1];

    list.push({
      at: row.occurred_at,
      activeSeconds: row.active_seconds === null ? 0 : Number(row.active_seconds),
      pageSpeedMs: row.page_speed_ms === null ? null : Number(row.page_speed_ms),
      toggledInterval: row.toggled,
      clickedPlan: row.clicked_plan,
      openedFaq: row.opened_faq,
      sessionEndedAfterSeconds:
        row.session_ended_at === null
          ? null
          : Math.max(0, (row.session_ended_at.getTime() - row.occurred_at.getTime()) / 1000),
      previousViews: list.length,
      previousViewAt: previous?.at ?? null,
    });
    byUser.set(row.visitor, list);
  }

  return byUser;
}

export interface PricingReadingRow {
  /** Null for an anonymous visitor. */
  userKey: number | null;
  visitor: number;
  at: Date;
  pattern: string;
  says: string;
  countsAsLeak: boolean;
  source: string;
  device: string;
  country: string;
  trialDay: string;
}

/**
 * Every pricing view, classified, with the context the splits need.
 *
 * One loader for two callers: the intent facts need to know whether a person read the
 * pricing page or deliberated over it, and the leak engine needs the quick exits and
 * the rate. Computing it twice would be two definitions of "quick exit".
 */
export async function loadPricingReadings(db: ScopedDb): Promise<PricingReadingRow[]> {
  const rows = await loadPricingRows(db);
  const byVisitor = pricingViewsByUser(rows);
  const thresholds = pricingThresholds(
    rows.map((row) => (row.active_seconds === null ? 0 : Number(row.active_seconds))),
  );

  // The views were built in the same order as the rows, per visitor, so walking both
  // together lines each reading up with the row it came from.
  const seen = new Map<number, number>();
  return rows.map((row) => {
    const index = seen.get(row.visitor) ?? 0;
    seen.set(row.visitor, index + 1);
    const view = byVisitor.get(row.visitor)![index]!;
    const reading = classifyPricingView(view, thresholds);

    return {
      userKey: row.user_key,
      visitor: row.visitor,
      at: row.occurred_at,
      pattern: reading.pattern,
      says: reading.says,
      countsAsLeak: reading.countsAsLeak,
      source: row.source ?? 'direct',
      device: row.device ?? 'unknown',
      country: row.country ?? 'unknown',
      trialDay: row.trial_day ?? 'no trial',
    };
  });
}

export interface IntentFactsResult {
  users: UserIntentFacts[];
  /** The product's own pricing thresholds, for the report to show. */
  pricing: PricingThresholds;
  /** The median time to value, and whether there are enough activations for one. */
  medianTimeToValueSeconds: number | null;
  activations: number;
}

export async function loadIntentFacts(
  db: ScopedDb,
  context: ProjectIntentContext,
  now: Date,
): Promise<IntentFactsResult> {
  const rows = await loadUserRows(db, now);
  const pricingRows = await loadPricingRows(db);
  const pricingByUser = pricingViewsByUser(pricingRows);

  const thresholds = pricingThresholds(
    pricingRows.map((row) => (row.active_seconds === null ? 0 : Number(row.active_seconds))),
  );

  /*
   * The median time to value, from this product's own activations.
   *
   * Brief §8.2: the +10 for activating faster than the median "needs enough
   * activations to have a median (assume 20 and record it)". Below that the signal is
   * simply off — a median of four people would hand out points for beating three.
   */
  const timeToValues = rows
    .map((row) => (row.time_to_value_seconds === null ? null : Number(row.time_to_value_seconds)))
    .filter((value): value is number => value !== null);
  const activations = timeToValues.length;
  const medianTimeToValueSeconds =
    activations >= ACTIVATIONS_FOR_MEDIAN_TTV ? internalMedian(timeToValues) : null;

  const users: UserIntentFacts[] = rows.map((row) => {
    const readings = (pricingByUser.get(row.user_key) ?? []).map((view) =>
      classifyPricingView(view, thresholds),
    );

    const views = pricingViews(pricingByUser, row.user_key);

    /*
     * Brief §8.2: Pricing Viewed is worth +10 "only after 10 seconds of active time
     * on the page" — the product's own 25th percentile once it has 50 views.
     *
     * So this is a test on the time, not on the pattern. Reading it off the pattern
     * instead gave the +10 to a `re-checking` view, which is explicitly "a view
     * under 10 seconds", and to a `none` — so a two-second glance by someone who had
     * seen the page before scored the same as someone who read it.
     */
    const firstAttentiveView = views.findIndex(
      (view) => view.activeSeconds >= thresholds.attentionSeconds,
    );
    const firstDeliberation = readings.findIndex((reading) => reading.deliberation);

    const fastActivation =
      medianTimeToValueSeconds !== null &&
      row.time_to_value_seconds !== null &&
      Number(row.time_to_value_seconds) < medianTimeToValueSeconds;

    const facts: IntentFacts = {
      ...emptyFacts(),
      lastEventAt: row.last_event_at,

      checkoutStarted: row.checkout_started_at !== null,
      activated: row.activated_at !== null,
      planLimitOrPaywall: row.plan_limit_or_paywall_at !== null,
      // A view that passed the attention bar is the +10; the bar is the product's own
      // once it has 50 views (brief §8.2).
      pricingViewed: firstAttentiveView >= 0,
      pricingDeliberation: firstDeliberation >= 0,
      inviteSent: row.invite_sent_at !== null,
      integrationOrImport: row.integration_or_import_at !== null,
      coreActionEarly: row.core_action_early_at !== null,
      activeThreeOfSeven: row.active_days_recent >= ACTIVE_DAYS_REQUIRED,
      fastActivation,
      paymentMethodBeforeTrialEnd: row.payment_method_before_trial_end_at !== null,
      salesContactRequested: row.sales_contact_requested_at !== null,
      disposableEmail: row.email_type === 'disposable',

      fit: fitPoints(row, context),
      priceObjection: row.dismissals >= PRICE_OBJECTION_DISMISSALS,
    };

    const timeline: SignalMoment[] = [];
    const add = (key: IntentSignalKey, at: Date | null) => {
      if (at !== null) timeline.push({ key, at });
    };
    add('checkoutStarted', row.checkout_started_at);
    add('activated', row.activated_at);
    add('planLimitOrPaywall', row.plan_limit_or_paywall_at);
    add('inviteSent', row.invite_sent_at);
    add('integrationOrImport', row.integration_or_import_at);
    add('salesContactRequested', row.sales_contact_requested_at);
    add('paymentMethodBeforeTrialEnd', row.payment_method_before_trial_end_at);
    add('coreActionEarly', row.core_action_early_at);
    add('pricingViewed', firstAttentiveView >= 0 ? (views[firstAttentiveView]?.at ?? null) : null);
    add(
      'pricingDeliberation',
      firstDeliberation >= 0 ? (views[firstDeliberation]?.at ?? null) : null,
    );
    // Faster-than-median activation is known at the moment they activated.
    if (fastActivation) add('fastActivation', row.activated_at);
    // Signup-time facts: true from the moment we knew who they were.
    if (facts.disposableEmail) add('disposableEmail', row.signed_up_at ?? row.last_event_at);
    timeline.sort((a, b) => a.at.getTime() - b.at.getTime());

    return {
      userKey: row.user_key,
      facts,
      paidAt: row.paid_at,
      signedUpAt: row.signed_up_at,
      pricing: readings.map((reading) => ({ pattern: reading.pattern, says: reading.says })),
      timeline,
    };
  });

  return { users, pricing: thresholds, medianTimeToValueSeconds, activations };
}

function pricingViews(byUser: Map<number, PricingViewFact[]>, userKey: number): PricingViewFact[] {
  return byUser.get(userKey) ?? [];
}

/**
 * The five fit points (brief §8.2).
 *
 * Each is +5 and the total is capped at 10 by the engine. Desktop-at-signup is
 * "(team products; off for mobile-first)", so it is not counted for a self-serve or
 * mobile-first product — on a phone-first product it would reward the minority of
 * users who happened to be at a laptop.
 */
function fitPoints(
  row: UserRow,
  context: ProjectIntentContext,
): Partial<Record<FitPointKey, boolean>> {
  const fit: Partial<Record<FitPointKey, boolean>> = {};

  if (row.email_type === 'work') fit.workEmail = true;

  const desktopCounts = context.productKind === 'team' && !context.mobileFirst;
  if (desktopCounts && row.signup_device === 'desktop') fit.desktopAtSignup = true;

  if (
    row.signed_up_at !== null &&
    inWorkingHours(row.signed_up_at, context.timezone, context.workingHours)
  ) {
    fit.workingHoursSignup = true;
  }

  const touch = row.first_touch ?? {};
  if (isReviewSite(touch.referrerDomain) || isBrandSearch(touch.utmTerm, context.brandTerms)) {
    fit.reviewOrBrandSearch = true;
  }

  if (row.visits_before_signup >= 2) fit.repeatVisitorBeforeSignup = true;

  return fit;
}

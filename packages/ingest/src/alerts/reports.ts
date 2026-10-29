import {
  alertFeed,
  changeWindowCounts,
  coverageFacts,
  currentProject,
  entitlements,
  limitOf,
  listChanges,
  recordReportRun,
  reportAlreadySent,
  reportRecipients,
  stepTrendRows,
  storeChangeResult,
  withProject,
  type ScopedDb,
} from '@dripmetric/db';
import {
  compareChange,
  coverage,
  digest,
  equalWindows,
  localDayKey,
  localHour,
  localWeekday,
  weeklyReport,
  type ChangeComparison,
  type LeakType,
  type WeeklyReportFacts,
  type WorstStepFact,
} from '@dripmetric/engine';
import { currentFunnelReport } from '../funnel/aggregate.js';
import { trackingProblems } from '../health/run.js';
import { intentSummary } from '../intent/state.js';
import { leakSummary } from '../leaks/sweeps.js';

/**
 * The weekly leak report, the daily digest and the Changes comparison (brief §9).
 *
 * All three are jobs rather than request handlers, and all three take `now`, because
 * all three are about the founder's own clock: Monday morning in their timezone, one
 * digest a day in their timezone, and equal windows either side of a change.
 *
 * Sending is injected. The worker passes a Resend-backed sender, the dev preview
 * route passes one that renders to the page, and tests pass a recorder — so no test
 * ever calls a paid API (CLAUDE.md rule 3).
 */

export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export type SendEmail = (email: OutgoingEmail) => Promise<void>;

/** Brief §9: "Monday morning in the founder's timezone." */
export const REPORT_WEEKDAY = 1;
export const REPORT_HOUR = 8;
/** Brief §9: the digest goes out once a day, in the evening, if there was anything. */
export const DIGEST_HOUR = 18;

// --- The facts the report is built from ------------------------------------

/**
 * Loads a week of facts.
 *
 * Reads only, and sequential: a `ScopedDb` is one client in one transaction, so
 * `Promise.all` over these would be sequential anyway and deprecated besides.
 */
export async function weeklyReportFacts(
  db: ScopedDb,
  now: Date,
  options: { dashboardUrl?: string | null; unsubscribeUrl?: string | null } = {},
): Promise<WeeklyReportFacts> {
  const project = await currentProject(db);
  const plan = await entitlements(db);
  const leaks = await leakSummary(db, now);
  const intent = await intentSummary(db, now);
  const funnel = await currentFunnelReport(db, now);
  const changes = await listChanges(db);
  const facts = await coverageFacts(db);

  const countOf = (type: LeakType): number =>
    leaks.byType.find((entry) => entry.type === type)?.firedThisWeek ?? 0;

  /*
   * Part 5: tracking health, "only when something is broken".
   *
   * Two sources, in order of what a founder should act on first. A tracking FINDING
   * (M11) is something that broke — an event that stopped arriving, a property that
   * changed type — and comes with its own sentence that blames the tracking rather
   * than the users. A switched-off metric is weaker: nothing broke, an event was
   * never wired.
   *
   * Only once the project has activity, and capped at three. A project that has never
   * sent an event has nothing broken; it is simply not set up, and it has a setup
   * screen for that. Without the gate `empty` would never be true and a brand-new
   * project would get a weekly email saying nothing happened.
   */
  const hasActivity = funnel.signedUp > 0 || intent.users > 0;
  const broken = await trackingProblems(db);
  const trackingProblems_ = hasActivity
    ? [
        ...broken,
        ...coverage(facts).switchedOff.map((off) => `${off.metric} is off: ${off.because}`),
      ].slice(0, 3)
    : [];

  return {
    projectName: project.name,
    dashboardUrl: options.dashboardUrl ?? null,
    unsubscribeUrl: options.unsubscribeUrl ?? null,
    listPriceAmount: project.settings.listPriceAmount,
    listPriceCurrency: project.settings.listPriceCurrency,

    highIntentDidntPayThisWeek: intent.didntPay.pastWindow + intent.didntPay.insideWindow,
    highIntentUsers: intent.bands.high,
    didntPayPastWindow: intent.didntPay.pastWindow,
    didntPayRevenue: intent.didntPay.potentialRevenue,
    didntPayNote: intent.didntPay.note,

    worstStep: await worstStepFact(db, funnel, now),

    lastMomentDrops: countOf('last-moment-drop'),
    payersGoingQuiet: countOf('payer-going-quiet'),
    onboardingStalls: countOf('onboarding-stall'),

    trackingProblems: trackingProblems_,

    /*
     * Part 6, the locked insight.
     *
     * The signal is the one the most high-intent non-payers share. It is a count on
     * Free and a count on paid — what the gate withholds is WHO, which is the reveal
     * the dashboard sells, so the report tells the truth either way and only the
     * closing line differs.
     */
    sharedSignal: await sharedSignalFact(db),
    insightLocked: !limitOf(plan, 'reveal_allowance') && plan.planCode === 'free',

    lastChange: await lastChangeFact(db, changes, now, limitOf(plan, 'change_window_days_max')),
  };
}

/** Part 2: the worst step, its drop-off and the move against last week. */
async function worstStepFact(
  db: ScopedDb,
  funnel: Awaited<ReturnType<typeof currentFunnelReport>>,
  now: Date,
): Promise<WorstStepFact | null> {
  // The highlighted step if the engine picked one, else the worst drop-off.
  const highlighted = funnel.steps.find((step) => step.stepId === funnel.highlightedStepId);
  const worst = highlighted ?? [...funnel.steps].sort(byDropOff)[0];
  if (!worst || worst.dropOffRate === null || worst.entered === 0) return null;

  // Last week's rate for the same step, from the 8-week trend.
  const trend = await stepTrendRows(db, now, 3);
  const mine = trend
    .filter((row) => row.stepId === worst.stepId && row.entered > 0)
    .sort((a, b) => (a.weekStart < b.weekStart ? 1 : -1));
  const previous = mine[1];

  return {
    label: worst.label,
    position: worst.position,
    entered: worst.entered,
    dropped: worst.droppedOff,
    dropRate: worst.dropOffRate,
    previousDropRate:
      previous === undefined || previous.entered === 0
        ? null
        : (previous.entered - previous.completed) / previous.entered,
    because:
      worst.highlight.says === ''
        ? 'More people drop out here than at any other step.'
        : worst.highlight.says,
  };
}

function byDropOff(
  a: { dropOffRate: number | null; droppedOff: number },
  b: { dropOffRate: number | null; droppedOff: number },
): number {
  // By how many people are lost, not by rate: a 90% drop-off over 10 users is not
  // the biggest leak in a funnel where another step loses 400 of 1,000.
  return b.droppedOff - a.droppedOff;
}

/** Part 6: the signal the most high-intent non-payers have in common. */
async function sharedSignalFact(db: ScopedDb): Promise<{ label: string; users: number } | null> {
  /*
   * One row per signal column, counted over the people who matter.
   *
   * The columns are the intent engine's own booleans, so this cannot drift from the
   * points table: a signal that is not stored cannot be reported.
   */
  const row = await db.maybeOne<{ signal: string; users: string }>(
    `WITH candidates AS (
       SELECT s.*
         FROM intent_state s
         JOIN end_users u ON u.project_id = s.project_id AND u.user_key = s.user_key
        WHERE s.project_id = $1
          AND s.peak_score >= 60
          AND u.paid_at IS NULL
          AND u.deleted_at IS NULL AND NOT u.internal AND NOT u.opted_out
     )
     SELECT signal, users FROM (
       SELECT 'read your pricing page closely' AS signal,
              count(*) FILTER (WHERE pricing_deliberation) AS users FROM candidates
       UNION ALL
       SELECT 'started checkout and stopped',
              count(*) FILTER (WHERE checkout_started) FROM candidates
       UNION ALL
       SELECT 'hit a limit of their plan',
              count(*) FILTER (WHERE plan_limit_or_paywall) FROM candidates
       UNION ALL
       SELECT 'invited a teammate',
              count(*) FILTER (WHERE invite_sent) FROM candidates
       UNION ALL
       SELECT 'connected an integration or imported data',
              count(*) FILTER (WHERE integration_or_import) FROM candidates
     ) counted
      WHERE users > 1
      ORDER BY users DESC
      LIMIT 1`,
    [db.projectId],
  );

  return row === null ? null : { label: row.signal, users: Number(row.users) };
}

/** Part 7: how the founder's last change is doing. */
async function lastChangeFact(
  db: ScopedDb,
  changes: Awaited<ReturnType<typeof listChanges>>,
  now: Date,
  maxWindowDays: number,
): Promise<{ note: string; comparison: ChangeComparison } | null> {
  const latest = changes[0];
  if (!latest) return null;

  const comparison = await compareOneChange(db, latest, now, maxWindowDays);
  return comparison === null ? null : { note: latest.note, comparison };
}

// --- The Changes comparison -----------------------------------------------

/**
 * Compares one change, using the frozen result when there is one.
 *
 * Brief §9: "Freeze the result when it is computed." So a change that has already
 * been decided is read back rather than recomputed — which is the difference between
 * a founder's before-and-after being a fact and being a number that drifts every
 * time the page is opened.
 */
export async function compareOneChange(
  db: ScopedDb,
  change: Awaited<ReturnType<typeof listChanges>>[number],
  now: Date,
  maxWindowDays: number,
): Promise<ChangeComparison | null> {
  if (change.result !== null && typeof change.result === 'object') {
    return change.result as ChangeComparison;
  }
  if (change.stepId === null) return null;

  const windows = equalWindows(change.happenedAt, now, maxWindowDays);
  if (windows.days <= 0) return null;

  const counts = await changeWindowCounts(db, change.stepId, windows);
  const comparison = compareChange({
    stepLabel: counts.stepLabel,
    before: { ...windows.before, ...counts.before },
    after: { ...windows.after, ...counts.after },
    windows,
  });

  // Frozen once it can be: "too early to tell" is not a result worth freezing.
  if (comparison.final) await storeChangeResult(db, change.id, comparison);
  return comparison;
}

/** Every change, for the dashboard's Changes module and the report's part 7. */
export async function changeComparisons(
  db: ScopedDb,
  now: Date,
): Promise<{ id: string; note: string; comparison: ChangeComparison }[]> {
  const plan = await entitlements(db);
  const maxDays = limitOf(plan, 'change_window_days_max');
  const changes = await listChanges(db);

  const out: { id: string; note: string; comparison: ChangeComparison }[] = [];
  for (const change of changes) {
    const comparison = await compareOneChange(db, change, now, maxDays);
    if (comparison !== null) out.push({ id: change.id, note: change.note, comparison });
  }
  return out;
}

// --- The jobs --------------------------------------------------------------

export interface ReportRunResult {
  ran: boolean;
  why: string;
  recipients: number;
  subject: string;
}

/**
 * The weekly report, if it is Monday morning where the founder is.
 *
 * The job runs hourly for every project and asks this question per project, because
 * one cron cannot be Monday 08:00 in forty timezones. `report_runs` carries the
 * founder's own local date as the period key, and its unique index is what stops a
 * founder in Auckland getting two.
 */
export async function runWeeklyReport(
  projectId: number,
  now: Date,
  options: { send: SendEmail; appUrl?: string | null; force?: boolean },
): Promise<ReportRunResult> {
  return withProject(
    projectId,
    async (db) => {
      const project = await currentProject(db);

      if (options.force !== true) {
        if (localWeekday(now, project.timezone) !== REPORT_WEEKDAY) {
          return skip('It is not Monday there yet.');
        }
        if (localHour(now, project.timezone) < REPORT_HOUR) {
          return skip('It is Monday but not yet morning there.');
        }
      }

      const periodKey = localDayKey(now, project.timezone);
      if (await reportAlreadySent(db, 'weekly', periodKey)) {
        return skip(`This week's report already went out (${periodKey}).`);
      }

      const recipients = await reportRecipients(db);
      const wanted = recipients.filter((person) => person.weeklyReport);

      const facts = await weeklyReportFacts(db, now, {
        dashboardUrl: dashboardUrl(options.appUrl, project.publicId),
      });
      const report = weeklyReport(facts);

      /*
       * A week with nothing in it gets no email.
       *
       * "Readable in 30 seconds" is not the only requirement; a Monday email that
       * says "nothing happened" every week is how a founder learns to filter us.
       * The run is still recorded, so the skip is visible rather than silent.
       */
      if (report.empty) {
        await recordReportRun(db, {
          kind: 'weekly',
          periodKey,
          recipients: 0,
          subject: report.subject,
          skippedBecause: 'Nothing worth reporting this week.',
        });
        return skip('Nothing worth reporting this week.');
      }

      for (const person of wanted) {
        const withLink = weeklyReport({
          ...facts,
          unsubscribeUrl: unsubscribeUrl(options.appUrl, project.publicId, person.unsubscribeToken),
        });
        await options.send({
          to: person.email,
          subject: withLink.subject,
          text: withLink.text,
          html: withLink.html,
        });
      }

      await recordReportRun(db, {
        kind: 'weekly',
        periodKey,
        recipients: wanted.length,
        subject: report.subject,
        skippedBecause: null,
      });

      return {
        ran: true,
        why: 'Sent.',
        recipients: wanted.length,
        subject: report.subject,
      };
    },
    { worker: true },
  );
}

/**
 * The daily digest, for founders with neither chat app (brief §9).
 *
 * "only on days with alerts" — so a quiet day sends nothing, and the engine's
 * `digest()` returns null for it rather than this job deciding separately.
 */
export async function runDailyDigest(
  projectId: number,
  now: Date,
  options: { send: SendEmail; appUrl?: string | null; force?: boolean },
): Promise<ReportRunResult> {
  return withProject(
    projectId,
    async (db) => {
      const project = await currentProject(db);
      if (
        project.settings.alertChannel === 'slack' ||
        project.settings.alertChannel === 'discord'
      ) {
        return skip('This project has a chat app, so it gets instant alerts instead.');
      }
      if (options.force !== true && localHour(now, project.timezone) < DIGEST_HOUR) {
        return skip('Too early in the day there.');
      }

      const periodKey = localDayKey(now, project.timezone);
      if (await reportAlreadySent(db, 'digest', periodKey)) {
        return skip(`Today's digest already went out (${periodKey}).`);
      }

      const feed = await alertFeed(db, now, { limit: 100 });
      const today = feed.filter((alert) => alert.when === 'today');

      const built = digest({
        projectName: project.name,
        dayLabel: periodKey,
        items: today.map((alert) => ({
          leakType: alert.leakType as LeakType,
          says: alert.says,
          when: alert.when,
        })),
        overCap: today.filter((alert) => alert.because.includes('daily limit')).length,
        dashboardUrl: dashboardUrl(options.appUrl, project.publicId),
        unsubscribeUrl: null,
      });

      if (built === null) {
        await recordReportRun(db, {
          kind: 'digest',
          periodKey,
          recipients: 0,
          subject: '',
          skippedBecause: 'No alerts today.',
        });
        return skip('No alerts today.');
      }

      const recipients = (await reportRecipients(db)).filter((person) => person.dailyDigest);
      for (const person of recipients) {
        await options.send({ to: person.email, subject: built.subject, text: built.text });
      }

      await recordReportRun(db, {
        kind: 'digest',
        periodKey,
        recipients: recipients.length,
        subject: built.subject,
        skippedBecause: null,
      });

      return { ran: true, why: 'Sent.', recipients: recipients.length, subject: built.subject };
    },
    { worker: true },
  );
}

function skip(why: string): ReportRunResult {
  return { ran: false, why, recipients: 0, subject: '' };
}

function dashboardUrl(appUrl: string | null | undefined, publicId: string): string | null {
  return appUrl === null || appUrl === undefined
    ? null
    : `${appUrl}/projects/${publicId}/dashboard`;
}

function unsubscribeUrl(
  appUrl: string | null | undefined,
  publicId: string,
  token: string | null,
): string | null {
  if (appUrl === null || appUrl === undefined || token === null) return null;
  return `${appUrl}/projects/${publicId}/reports/unsubscribe?token=${token}`;
}

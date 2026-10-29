import type { PotentialRevenue } from '../intent/didnt-pay.js';
import { formatMoney, plural } from '../money.js';
import type { ChangeComparison } from './changes.js';

/**
 * The weekly leak report (brief §9).
 *
 * "Email through our own Resend account, Monday morning in the founder's timezone,
 * readable in 30 seconds, with a one-click unsubscribe." Then eight numbered parts,
 * which are built here in that order and nowhere else.
 *
 * Pure, like every engine: it takes the facts and returns the subject, the parts and
 * both renderings. The job that loads the facts and the route that previews the
 * report therefore produce byte-identical output, which is what makes the dev preview
 * worth looking at (brief §9: "Provide a dev route that renders the report and an
 * example alert from simulator data, so I can look at them").
 */

/**
 * Brief §9 part 8: "Starter is $24.99… Keep 24.99 in config."
 *
 * Minor units, like every other price in the codebase. It matches the `starter` row
 * seeded in migration 0001; if the price ever changes, both move together or the
 * report lies.
 */
export const STARTER_PRICE_MINOR = 2_499;

/** The report's eight parts, in the brief's own order. */
export const REPORT_PARTS = [
  'headline',
  'biggest-leak',
  'intent',
  'counts',
  'tracking',
  'insight',
  'change',
  'payback',
] as const;
export type ReportPartKey = (typeof REPORT_PARTS)[number];

export interface ReportPart {
  key: ReportPartKey;
  heading: string;
  lines: string[];
  /** True for the one locked insight: shown as a tease, not as a number. */
  locked: boolean;
}

export interface WorstStepFact {
  label: string;
  position: number;
  entered: number;
  dropped: number;
  /** 0–1. */
  dropRate: number;
  /** The same step's drop rate in the week before, when there is one. */
  previousDropRate: number | null;
  /** Why this step and not another, from the funnel engine's highlight. */
  because: string;
}

export interface WeeklyReportFacts {
  projectName: string;
  /** Null when no app URL is configured, which only happens in a test. */
  dashboardUrl: string | null;
  unsubscribeUrl: string | null;

  listPriceAmount: number | null;
  listPriceCurrency: string;

  /** Part 1: reached high intent in the last 7 days and have not paid. */
  highIntentDidntPayThisWeek: number;
  /** Part 3. */
  highIntentUsers: number;
  didntPayPastWindow: number;
  didntPayRevenue: PotentialRevenue | null;
  /** The plain note shown while the revenue figure is off (no paid event yet). */
  didntPayNote: string | null;

  /** Part 2. Null before there is a funnel with traffic in it. */
  worstStep: WorstStepFact | null;

  /** Part 4, as counts. */
  lastMomentDrops: number;
  payersGoingQuiet: number;
  onboardingStalls: number;

  /** Part 5: empty unless something is actually broken (brief §9). */
  trackingProblems: readonly string[];

  /** Part 6: the signal the most high-intent non-payers share. */
  sharedSignal: { label: string; users: number } | null;
  /** True on Free: the insight is a tease, not a list of names. */
  insightLocked: boolean;

  /** Part 7, when the founder has marked a change. */
  lastChange: { note: string; comparison: ChangeComparison } | null;
}

export interface WeeklyReport {
  subject: string;
  parts: ReportPart[];
  text: string;
  html: string;
  /**
   * True when there is nothing to report: no high-intent non-payers, no leaks, no
   * worst step, nothing broken. A weekly email that says "nothing happened" every
   * Monday is how a founder learns to filter us.
   */
  empty: boolean;
}

export function weeklyReport(facts: WeeklyReportFacts): WeeklyReport {
  const parts: ReportPart[] = [];
  const n = facts.highIntentDidntPayThisWeek;

  // 1. The subject and the headline (brief §9 part 1).
  const subject =
    n === 0
      ? `Your week on ${facts.projectName}: no one with buying intent is waiting`
      : `${plural(n, 'user')} with buying intent didn't pay last week`;

  parts.push({
    key: 'headline',
    heading: 'Last week',
    lines:
      n === 0
        ? ['No one reached high buying intent and left without paying. That is the good version.']
        : [`${plural(n, 'user')} reached high buying intent in the last 7 days and have not paid.`],
    locked: false,
  });

  // 2. The biggest leak (brief §9 part 2): the worst step, its drop-off, and the
  //    change against last week.
  if (facts.worstStep !== null) {
    const step = facts.worstStep;
    const lines = [
      `Step ${step.position}, ${step.label}: ${percent(step.dropRate)} of the ${plural(step.entered, 'user')} who got there dropped out.`,
      step.because,
    ];
    if (step.previousDropRate !== null) {
      lines.push(weekOnWeek(step.dropRate, step.previousDropRate));
    } else {
      // Said rather than left out: a founder who sees no comparison should know it
      // is missing because we have no week to compare, not because nothing moved.
      lines.push('No comparison yet — this is the first week with enough traffic on this step.');
    }
    parts.push({ key: 'biggest-leak', heading: 'Your biggest leak', lines, locked: false });
  }

  // 3. Intent (brief §9 part 3).
  const intentLines = [
    `${plural(facts.highIntentUsers, 'user')} are at high buying intent right now.`,
    `${facts.didntPayPastWindow.toLocaleString('en-US')} of them are past your "didn't pay" window.`,
  ];
  if (facts.didntPayRevenue !== null) {
    intentLines.push(
      `That is ${formatMoney(facts.didntPayRevenue.amountMinor, facts.didntPayRevenue.currency)} at your list price (${facts.didntPayRevenue.formula}).`,
    );
  } else if (facts.didntPayNote !== null) {
    intentLines.push(facts.didntPayNote);
  }
  parts.push({ key: 'intent', heading: 'Buying intent', lines: intentLines, locked: false });

  // 4. Last-moment drops and payers going quiet, as counts (brief §9 part 4).
  parts.push({
    key: 'counts',
    heading: 'Also last week',
    lines: [
      `${plural(facts.lastMomentDrops, 'checkout')} started with no payment after it.`,
      `${plural(facts.payersGoingQuiet, 'paying customer')} went quiet against their own baseline.`,
      `${plural(facts.onboardingStalls, 'person', 'people')} are stuck in onboarding.`,
    ],
    locked: false,
  });

  // 5. Tracking health, ONLY when something is broken (brief §9 part 5).
  if (facts.trackingProblems.length > 0) {
    parts.push({
      key: 'tracking',
      heading: 'Your tracking needs a look',
      lines: [...facts.trackingProblems],
      locked: false,
    });
  }

  // 6. One locked insight (brief §9 part 6).
  if (facts.sharedSignal !== null && facts.sharedSignal.users > 1) {
    const signal = facts.sharedSignal;
    parts.push({
      key: 'insight',
      heading: 'One thing they have in common',
      lines: facts.insightLocked
        ? [
            `${signal.users.toLocaleString('en-US')} of them share the same signal: ${signal.label}.`,
            'See who on Starter.',
          ]
        : [
            `${signal.users.toLocaleString('en-US')} of them share the same signal: ${signal.label}.`,
          ],
      locked: facts.insightLocked,
    });
  }

  // 7. Progress on the founder's last change (brief §9 part 7).
  if (facts.lastChange !== null) {
    parts.push({
      key: 'change',
      heading: 'The change you made',
      lines: [`You noted: "${facts.lastChange.note}"`, facts.lastChange.comparison.says],
      locked: false,
    });
  }

  // 8. The payback line (brief §9 part 8).
  const payback = paybackLine(facts.listPriceAmount, facts.listPriceCurrency, n);
  if (payback !== null) {
    parts.push({
      key: 'payback',
      heading: 'What it would take to cover',
      lines: [payback],
      locked: false,
    });
  }

  const empty =
    n === 0 &&
    facts.worstStep === null &&
    facts.highIntentUsers === 0 &&
    facts.lastMomentDrops === 0 &&
    facts.payersGoingQuiet === 0 &&
    facts.onboardingStalls === 0 &&
    facts.trackingProblems.length === 0;

  return {
    subject,
    parts,
    text: renderText(parts, facts),
    html: renderHtml(subject, parts, facts),
    empty,
  };
}

/**
 * Brief §9 part 8: "Starter is $24.99; at your ${price} price, saving {m} of these
 * users covers it", with m = ceil(24.99 / price). Show it only when the project's
 * currency is USD.
 *
 * The USD-only rule is not laziness: converting the founder's currency would need a
 * rate, a rate has a date, and a sentence about what our own plan costs is the last
 * place to introduce a number we cannot show the working for.
 */
export function paybackLine(
  listPriceMinor: number | null,
  currency: string,
  usersAtStake: number,
): string | null {
  if (listPriceMinor === null || listPriceMinor <= 0) return null;
  if (currency.toLowerCase() !== 'usd') return null;

  // Both sides in minor units, so the division stays integer arithmetic.
  const m = Math.ceil(STARTER_PRICE_MINOR / listPriceMinor);
  const covers =
    usersAtStake > 0 && m <= usersAtStake
      ? `saving ${m.toLocaleString('en-US')} of these users covers it`
      : `saving ${plural(m, 'user')} covers it`;

  return `Starter is ${formatMoney(STARTER_PRICE_MINOR, 'usd')}; at your ${formatMoney(listPriceMinor, currency)} price, ${covers}.`;
}

/** The week-on-week line for the worst step. */
function weekOnWeek(current: number, previous: number): string {
  const points = (current - previous) * 100;
  if (Math.abs(points) < 0.5) return `The same as the week before (${percent(previous)}).`;
  const direction = points > 0 ? 'worse' : 'better';
  return `${Math.abs(points).toFixed(1)} points ${direction} than the week before (${percent(previous)}).`;
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function renderText(parts: readonly ReportPart[], facts: WeeklyReportFacts): string {
  const blocks = parts.map((part) => `${part.heading.toUpperCase()}\n${part.lines.join('\n')}`);
  if (facts.dashboardUrl !== null) blocks.push(`See the whole dashboard: ${facts.dashboardUrl}`);
  if (facts.unsubscribeUrl !== null) {
    blocks.push(`Stop these emails in one click: ${facts.unsubscribeUrl}`);
  }
  return blocks.join('\n\n');
}

/**
 * The HTML, with styles inline.
 *
 * Email clients strip `<style>` blocks and have no CSS support worth relying on, so
 * every rule is on the element that needs it. Plain text comes with it in the same
 * email, which is what makes the one-click unsubscribe work in clients that refuse
 * HTML entirely.
 */
function renderHtml(
  subject: string,
  parts: readonly ReportPart[],
  facts: WeeklyReportFacts,
): string {
  const body = parts
    .map((part) => {
      const lines = part.lines
        .map(
          (line) =>
            `<p style="margin:0 0 6px;font-size:15px;line-height:1.5;color:#1f2430">${escapeHtml(line)}</p>`,
        )
        .join('');
      const lock = part.locked ? ' <span style="font-size:12px;color:#8a8f9c">(locked)</span>' : '';
      return (
        `<tr><td style="padding:14px 0;border-bottom:1px solid #eceef2">` +
        `<p style="margin:0 0 6px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#6b7280">${escapeHtml(part.heading)}${lock}</p>` +
        `${lines}</td></tr>`
      );
    })
    .join('');

  const footer: string[] = [];
  if (facts.dashboardUrl !== null) {
    footer.push(
      `<a href="${escapeHtml(facts.dashboardUrl)}" style="color:#2f5fd9">See the whole dashboard</a>`,
    );
  }
  if (facts.unsubscribeUrl !== null) {
    footer.push(
      `<a href="${escapeHtml(facts.unsubscribeUrl)}" style="color:#6b7280">Unsubscribe in one click</a>`,
    );
  }

  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${escapeHtml(subject)}</title></head>` +
    `<body style="margin:0;padding:24px 12px;background:#f6f7f9;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#fff;border-radius:10px;padding:20px 22px">` +
    `<tr><td style="padding-bottom:4px"><p style="margin:0;font-size:18px;font-weight:600;color:#1f2430">${escapeHtml(subject)}</p>` +
    `<p style="margin:4px 0 0;font-size:13px;color:#6b7280">${escapeHtml(facts.projectName)}</p></td></tr>` +
    body +
    `<tr><td style="padding-top:16px;font-size:13px;color:#6b7280">${footer.join(' &nbsp;·&nbsp; ')}</td></tr>` +
    `</table></body></html>`
  );
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

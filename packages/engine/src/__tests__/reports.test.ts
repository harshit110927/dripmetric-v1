import { describe, expect, it } from 'vitest';
import {
  paybackLine,
  REPORT_PARTS,
  STARTER_PRICE_MINOR,
  weeklyReport,
  type WeeklyReportFacts,
} from '../reports/weekly.js';
import {
  compareChange,
  equalWindows,
  FREE_WINDOW_DAYS_MAX,
  MIN_USERS_PER_WINDOW,
  type ChangeWindow,
} from '../reports/changes.js';
import { digest, type DigestFacts } from '../reports/digest.js';

const MONDAY = new Date('2026-11-02T08:00:00Z');
const DAY = 86_400_000;

function facts(over: Partial<WeeklyReportFacts> = {}): WeeklyReportFacts {
  return {
    projectName: 'Ledgerly',
    dashboardUrl: 'https://app.example.test/projects/abc/dashboard',
    unsubscribeUrl: 'https://app.example.test/unsubscribe/tok',
    listPriceAmount: 4_900,
    listPriceCurrency: 'usd',
    highIntentDidntPayThisWeek: 7,
    highIntentUsers: 23,
    didntPayPastWindow: 9,
    didntPayRevenue: {
      amountMinor: 44_100,
      currency: 'usd',
      users: 9,
      pricePerUserMinor: 4_900,
      formula: '9 users × $49.00',
    },
    didntPayNote: null,
    worstStep: {
      label: 'Connect a data source',
      position: 2,
      entered: 410,
      dropped: 266,
      dropRate: 0.649,
      previousDropRate: 0.58,
      because: 'More people drop here than at any other step.',
    },
    lastMomentDrops: 4,
    payersGoingQuiet: 2,
    onboardingStalls: 31,
    trackingProblems: [],
    sharedSignal: { label: 'read the pricing page twice', users: 5 },
    insightLocked: true,
    lastChange: null,
    ...over,
  };
}

describe('the weekly leak report', () => {
  it('uses the brief’s own subject line', () => {
    expect(weeklyReport(facts()).subject).toBe("7 users with buying intent didn't pay last week");
    expect(weeklyReport(facts({ highIntentDidntPayThisWeek: 1 })).subject).toBe(
      "1 user with buying intent didn't pay last week",
    );
  });

  it('builds the eight parts in the brief’s order', () => {
    const report = weeklyReport(
      facts({
        trackingProblems: ['No Signed Up for 26 hours.'],
        lastChange: {
          note: 'shortened the step 2 form',
          comparison: compareChange({
            stepLabel: 'Connect a data source',
            before: { from: new Date(), to: new Date(), entered: 300, completed: 120 },
            after: { from: new Date(), to: new Date(), entered: 300, completed: 180 },
            windows: equalWindows(
              new Date(MONDAY.getTime() - 20 * DAY),
              MONDAY,
              FREE_WINDOW_DAYS_MAX,
            ),
          }),
        },
      }),
    );

    expect(report.parts.map((part) => part.key)).toEqual([...REPORT_PARTS]);
  });

  it('leaves out tracking health unless something is actually broken', () => {
    // Brief §9 part 5: "only when something is broken".
    expect(weeklyReport(facts()).parts.some((p) => p.key === 'tracking')).toBe(false);
    const broken = weeklyReport(facts({ trackingProblems: ['No Signed Up for 26 hours.'] }));
    expect(broken.parts.find((p) => p.key === 'tracking')?.lines).toEqual([
      'No Signed Up for 26 hours.',
    ]);
  });

  it('teases the locked insight on free and states it plainly on paid', () => {
    const free = weeklyReport(facts()).parts.find((p) => p.key === 'insight');
    expect(free?.locked).toBe(true);
    expect(free?.lines.at(-1)).toBe('See who on Starter.');

    const paid = weeklyReport(facts({ insightLocked: false })).parts.find(
      (p) => p.key === 'insight',
    );
    expect(paid?.locked).toBe(false);
    expect(paid?.lines).toHaveLength(1);
  });

  it('says the week-on-week move on the worst step, in points', () => {
    const lines = weeklyReport(facts()).parts.find((p) => p.key === 'biggest-leak')?.lines ?? [];
    expect(lines[0]).toContain('64.9%');
    expect(lines.at(-1)).toBe('6.9 points worse than the week before (58.0%).');
  });

  it('says so when there is no week to compare against', () => {
    const step = { ...facts().worstStep!, previousDropRate: null };
    const lines =
      weeklyReport(facts({ worstStep: step })).parts.find((p) => p.key === 'biggest-leak')?.lines ??
      [];
    expect(lines.at(-1)).toContain('first week with enough traffic');
  });

  it('falls back to the plain note when the revenue figure is off', () => {
    const report = weeklyReport(
      facts({
        didntPayRevenue: null,
        didntPayNote: 'No paid event yet, so there is no money figure.',
      }),
    );
    expect(report.parts.find((p) => p.key === 'intent')?.lines.at(-1)).toBe(
      'No paid event yet, so there is no money figure.',
    );
  });

  it('carries the one-click unsubscribe in both renderings', () => {
    const report = weeklyReport(facts());
    expect(report.text).toContain('https://app.example.test/unsubscribe/tok');
    expect(report.html).toContain('https://app.example.test/unsubscribe/tok');
    expect(report.html).toContain('Unsubscribe in one click');
  });

  it('escapes the founder’s own words in the HTML', () => {
    const report = weeklyReport(
      facts({
        lastChange: {
          note: '<script>alert(1)</script>',
          comparison: compareChange({
            stepLabel: null,
            before: { from: new Date(), to: new Date(), entered: 0, completed: 0 },
            after: { from: new Date(), to: new Date(), entered: 0, completed: 0 },
            windows: equalWindows(new Date(MONDAY.getTime() - DAY), MONDAY, FREE_WINDOW_DAYS_MAX),
          }),
        },
      }),
    );
    expect(report.html).not.toContain('<script>');
    expect(report.html).toContain('&lt;script&gt;');
  });

  it('knows when there is nothing worth sending', () => {
    const quiet = weeklyReport(
      facts({
        highIntentDidntPayThisWeek: 0,
        highIntentUsers: 0,
        didntPayPastWindow: 0,
        didntPayRevenue: null,
        worstStep: null,
        lastMomentDrops: 0,
        payersGoingQuiet: 0,
        onboardingStalls: 0,
        sharedSignal: null,
      }),
    );
    expect(quiet.empty).toBe(true);
    expect(weeklyReport(facts()).empty).toBe(false);
  });
});

describe('the payback line', () => {
  it('is the brief’s sentence, with m = ceil(24.99 / price)', () => {
    // $49.00 → ceil(2499/4900) = 1.
    expect(paybackLine(4_900, 'usd', 7)).toBe(
      'Starter is $24.99; at your $49.00 price, saving 1 of these users covers it.',
    );
    // $9.00 → ceil(2499/900) = 3.
    expect(paybackLine(900, 'usd', 7)).toBe(
      'Starter is $24.99; at your $9.00 price, saving 3 of these users covers it.',
    );
    // $5.00 → ceil(2499/500) = 5, and only 2 users at stake, so not "of these".
    expect(paybackLine(500, 'usd', 2)).toBe(
      'Starter is $24.99; at your $5.00 price, saving 5 users covers it.',
    );
  });

  it('is shown only when the project’s currency is USD', () => {
    // Converting would need a rate, and a rate has a date we cannot show working for.
    expect(paybackLine(4_900, 'eur', 7)).toBeNull();
    expect(paybackLine(4_900, 'gbp', 7)).toBeNull();
  });

  it('is absent when there is no price to divide into', () => {
    expect(paybackLine(null, 'usd', 7)).toBeNull();
    expect(paybackLine(0, 'usd', 7)).toBeNull();
  });

  it('keeps 24.99 in config, matching the seeded starter plan', () => {
    expect(STARTER_PRICE_MINOR).toBe(2_499);
  });
});

function window_(entered: number, completed: number): ChangeWindow {
  return { from: new Date(), to: new Date(), entered, completed };
}

describe('the before-and-after comparison', () => {
  it('says "too early to tell" under 100 users in a window', () => {
    // M10's exit check.
    const result = compareChange({
      stepLabel: 'Connect a data source',
      before: window_(140, 60),
      after: window_(41, 22),
      windows: equalWindows(new Date(MONDAY.getTime() - 9 * DAY), MONDAY, FREE_WINDOW_DAYS_MAX),
    });

    expect(result.verdict).toBe('too-early');
    expect(result.says).toContain('Too early to tell');
    // Said as a number, so the wait has an end.
    expect(result.says).toContain('140 before and 41 after');
    expect(result.says).toContain(`${MIN_USERS_PER_WINDOW - 41} more users`);
    expect(result.final).toBe(false);
  });

  it('is too early when EITHER side is short, not when the total is', () => {
    const result = compareChange({
      stepLabel: 'Sign up',
      before: window_(900, 400),
      after: window_(99, 60),
      windows: equalWindows(new Date(MONDAY.getTime() - 30 * DAY), MONDAY, FREE_WINDOW_DAYS_MAX),
    });
    expect(result.verdict).toBe('too-early');
  });

  it('prints the brief’s sentence once both windows are full', () => {
    const result = compareChange({
      stepLabel: 'step 2',
      before: window_(300, 120),
      after: window_(300, 180),
      windows: equalWindows(new Date(MONDAY.getTime() - 30 * DAY), MONDAY, FREE_WINDOW_DAYS_MAX),
    });
    expect(result.verdict).toBe('improved');
    expect(result.says).toBe(
      'Since you changed step 2, completion went from 40.0% to 60.0% across 600 users.',
    );
    // Brief §9: "Freeze the result when it is computed."
    expect(result.final).toBe(true);
  });

  it('calls a move inside the tolerance unchanged rather than a win', () => {
    const result = compareChange({
      stepLabel: 'step 2',
      before: window_(400, 200),
      after: window_(400, 208),
      windows: equalWindows(new Date(MONDAY.getTime() - 30 * DAY), MONDAY, FREE_WINDOW_DAYS_MAX),
    });
    expect(result.verdict).toBe('no-change');
    expect(result.says).toContain('close enough to call it unchanged');
  });

  it('reports a change for the worse as plainly as one for the better', () => {
    const result = compareChange({
      stepLabel: 'step 2',
      before: window_(300, 180),
      after: window_(300, 120),
      windows: equalWindows(new Date(MONDAY.getTime() - 30 * DAY), MONDAY, FREE_WINDOW_DAYS_MAX),
    });
    expect(result.verdict).toBe('worse');
    expect(result.says).toContain('from 60.0% to 40.0%');
  });

  it('shows its working', () => {
    const result = compareChange({
      stepLabel: 'step 2',
      before: window_(300, 120),
      after: window_(300, 180),
      windows: equalWindows(new Date(MONDAY.getTime() - 30 * DAY), MONDAY, FREE_WINDOW_DAYS_MAX),
    });
    expect(result.formula).toContain('Before: 120 of 300');
    expect(result.formula).toContain('After: 180 of 300');
  });

  it('measures equal windows either side, widening until the plan’s cap', () => {
    const happenedAt = new Date(MONDAY.getTime() - 10 * DAY);
    const early = equalWindows(happenedAt, MONDAY, FREE_WINDOW_DAYS_MAX);
    expect(early.days).toBe(10);
    expect(early.before.from.toISOString()).toBe(
      new Date(happenedAt.getTime() - 10 * DAY).toISOString(),
    );
    expect(early.after.to.toISOString()).toBe(MONDAY.toISOString());
    expect(early.cappedByPlan).toBe(false);
  });

  it('caps the free comparison at 45 days a side', () => {
    const happenedAt = new Date(MONDAY.getTime() - 200 * DAY);
    const capped = equalWindows(happenedAt, MONDAY, FREE_WINDOW_DAYS_MAX);
    expect(capped.days).toBe(FREE_WINDOW_DAYS_MAX);
    expect(capped.cappedByPlan).toBe(true);
    // Equal by construction, whatever the cap did.
    const beforeSpan = capped.before.to.getTime() - capped.before.from.getTime();
    const afterSpan = capped.after.to.getTime() - capped.after.from.getTime();
    expect(beforeSpan).toBe(afterSpan);
  });
});

function digestFacts(over: Partial<DigestFacts> = {}): DigestFacts {
  return {
    projectName: 'Ledgerly',
    dayLabel: '2 November',
    items: [
      { leakType: 'last-moment-drop', says: 'Checkout started, no payment.', when: 'today' },
      { leakType: 'last-moment-drop', says: 'Checkout started, no payment.', when: 'today' },
      { leakType: 'high-intent-quiet', says: 'Reached 72 and went quiet.', when: 'today' },
    ],
    overCap: 0,
    dashboardUrl: 'https://app.example.test/d',
    unsubscribeUrl: 'https://app.example.test/u',
    ...over,
  };
}

describe('the daily digest', () => {
  it('sends nothing on a day with no alerts', () => {
    // Brief §9: "only on days with alerts".
    expect(digest(digestFacts({ items: [] }))).toBeNull();
  });

  it('groups by leak rather than repeating the same sentence', () => {
    const result = digest(digestFacts());
    expect(result?.text).toContain('Someone started checkout and did not pay — 2 times');
    expect(result?.text).toContain('Someone with buying intent went quiet — 1 time');
    expect(result?.subject).toBe('3 leaks on Ledgerly — 2 November');
  });

  it('says how many went to the feed only because of the cap', () => {
    const result = digest(digestFacts({ overCap: 4 }));
    expect(result?.text).toContain('4 alerts went to your feed only');
  });

  it('carries the one-click unsubscribe', () => {
    expect(digest(digestFacts())?.text).toContain('https://app.example.test/u');
  });
});

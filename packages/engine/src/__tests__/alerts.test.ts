import { describe, expect, it } from 'vitest';
import {
  DEFAULT_QUIET_HOURS,
  inQuietHours,
  localDayKey,
  nextMorning,
  startOfLocalDay,
} from '../alerts/quiet-hours.js';
import {
  decideAlerts,
  DEFAULT_ALERTS_PER_DAY,
  type AlertCandidate,
  type AlertPolicyInput,
} from '../alerts/policy.js';
import {
  alertContent,
  DISCORD_LIMITS,
  SLACK_LIMITS,
  toDiscord,
  toSlack,
  WEBHOOK_USERNAME,
  type AlertFacts,
} from '../alerts/payload.js';
import type { SubjectGuards } from '../leaks/rules.js';
import type { LeakType } from '../leaks/types.js';

const BERLIN = 'Europe/Berlin';
const AUCKLAND = 'Pacific/Auckland';

function guards(over: Partial<SubjectGuards> = {}): SubjectGuards {
  return { paidAt: null, deletedAt: null, optedOut: false, ...over };
}

describe('quiet hours', () => {
  it('treats 22:00–08:00 as one window across midnight', () => {
    // The whole point: the window is not a range in the arithmetic sense.
    const quiet = DEFAULT_QUIET_HOURS;
    // 23:00 Berlin = 22:00 UTC in winter.
    expect(inQuietHours(new Date('2026-11-10T22:00:00Z'), BERLIN, quiet)).toBe(true);
    // 03:00 Berlin.
    expect(inQuietHours(new Date('2026-11-10T02:00:00Z'), BERLIN, quiet)).toBe(true);
    // 09:00 Berlin: awake.
    expect(inQuietHours(new Date('2026-11-10T08:00:00Z'), BERLIN, quiet)).toBe(false);
    // 21:00 Berlin: still awake.
    expect(inQuietHours(new Date('2026-11-10T20:00:00Z'), BERLIN, quiet)).toBe(false);
  });

  it('treats a window with equal hours as always quiet, so nothing is ever held', () => {
    const always = { startHour: 9, endHour: 9 };
    const at = new Date('2026-11-10T12:00:00Z');
    expect(inQuietHours(at, BERLIN, always)).toBe(true);
    // No morning to wait for: holding forever would be a silent drop.
    expect(nextMorning(at, BERLIN, always).getTime()).toBe(at.getTime());
  });

  it('releases a held alert in the morning, not 10 hours later', () => {
    // 23:30 Berlin on 10 November (UTC+1).
    const held = new Date('2026-11-10T22:30:00Z');
    const morning = nextMorning(held, BERLIN, DEFAULT_QUIET_HOURS);
    // 08:00 Berlin = 07:00 UTC the next day.
    expect(morning.toISOString()).toBe('2026-11-11T07:00:00.000Z');
    expect(inQuietHours(morning, BERLIN, DEFAULT_QUIET_HOURS)).toBe(false);
  });

  it('still releases at 08:00 local on the 25-hour night the clocks go back', () => {
    /*
     * Europe/Berlin leaves DST at 03:00 local on 25 October 2026, so that night is
     * 25 hours long. Adding a fixed offset would release this alert at 07:00 local.
     * Stepping hour by hour is what makes it 08:00.
     */
    const held = new Date('2026-10-24T21:30:00Z'); // 23:30 Berlin, UTC+2
    const morning = nextMorning(held, BERLIN, DEFAULT_QUIET_HOURS);
    expect(morning.toISOString()).toBe('2026-10-25T07:00:00.000Z'); // 08:00, now UTC+1
    expect(inQuietHours(morning, BERLIN, DEFAULT_QUIET_HOURS)).toBe(false);
  });

  it('counts the founder’s local day, not a UTC one', () => {
    /*
     * The cap's window. 2026-11-10T20:00Z is already the 11th in Auckland, so a UTC
     * day would reset the founder's cap in the middle of their afternoon.
     */
    const at = new Date('2026-11-10T20:00:00Z');
    expect(localDayKey(at, AUCKLAND)).toBe('2026-11-11');
    expect(localDayKey(at, BERLIN)).toBe('2026-11-10');

    const start = startOfLocalDay(at, AUCKLAND);
    // Midnight on the 11th in Auckland (UTC+13 in November) is 11:00Z on the 10th.
    expect(start.toISOString()).toBe('2026-11-10T11:00:00.000Z');
    expect(localDayKey(start, AUCKLAND)).toBe('2026-11-11');
    // The millisecond before belongs to the previous local day.
    expect(localDayKey(new Date(start.getTime() - 1), AUCKLAND)).toBe('2026-11-10');
  });

  it('finds local midnight in a zone whose offset is not a whole hour', () => {
    // Asia/Kolkata is UTC+05:30, which an hour-stepping implementation gets wrong.
    const at = new Date('2026-11-10T12:00:00Z');
    const start = startOfLocalDay(at, 'Asia/Kolkata');
    expect(start.toISOString()).toBe('2026-11-09T18:30:00.000Z');
  });
});

function candidate(
  id: string,
  leakType: LeakType = 'last-moment-drop',
  subjectKey = 1,
): AlertCandidate {
  return {
    leakInstanceId: id,
    leakType,
    subjectKind: leakType === 'step-collapse' ? 'step' : 'user',
    subjectKey,
    firedAt: new Date('2026-11-10T10:00:00Z'),
  };
}

function policyInput(over: Partial<AlertPolicyInput> = {}): AlertPolicyInput {
  return {
    candidates: [candidate('1')],
    channel: 'slack',
    timeZone: BERLIN,
    quietHours: DEFAULT_QUIET_HOURS,
    sentToday: 0,
    cap: DEFAULT_ALERTS_PER_DAY,
    // 14:00 Berlin: awake.
    now: new Date('2026-11-10T13:00:00Z'),
    guards: new Map([[1, guards()]]),
    ...over,
  };
}

describe('the alert policy', () => {
  it('sends an alert in waking hours', () => {
    const plan = decideAlerts(policyInput());
    expect(plan.decisions[0]?.route).toBe('send');
    expect(plan.sending).toBe(1);
  });

  it('sends the first ten of a day and puts the eleventh in the feed only', () => {
    // M10's exit check, stated as the brief states it.
    const candidates = Array.from({ length: 11 }, (_, i) =>
      candidate(String(i + 1), 'last-moment-drop', i + 1),
    );
    const plan = decideAlerts(
      policyInput({
        candidates,
        guards: new Map(candidates.map((c) => [c.subjectKey, guards()])),
      }),
    );

    expect(plan.sending).toBe(DEFAULT_ALERTS_PER_DAY);
    expect(plan.overCap).toBe(1);
    const eleventh = plan.decisions[10];
    expect(eleventh?.route).toBe('feed-only');
    expect(eleventh?.because).toContain('10 alerts today');
  });

  it('counts what already went out today against the cap', () => {
    const plan = decideAlerts(policyInput({ sentToday: DEFAULT_ALERTS_PER_DAY }));
    expect(plan.sending).toBe(0);
    expect(plan.overCap).toBe(1);
  });

  it('holds an alert raised in quiet hours until the morning', () => {
    const plan = decideAlerts(policyInput({ now: new Date('2026-11-10T22:30:00Z') }));
    const decision = plan.decisions[0];
    expect(decision?.route).toBe('hold');
    expect(decision?.holdUntil?.toISOString()).toBe('2026-11-11T07:00:00.000Z');
    expect(decision?.because).toContain('22:00 to 08:00');
    expect(plan.held).toBe(1);
  });

  it('counts a held alert against the cap, so a quiet night cannot stack thirty', () => {
    const candidates = Array.from({ length: 11 }, (_, i) =>
      candidate(String(i + 1), 'last-moment-drop', i + 1),
    );
    const plan = decideAlerts(
      policyInput({
        candidates,
        now: new Date('2026-11-10T22:30:00Z'),
        guards: new Map(candidates.map((c) => [c.subjectKey, guards()])),
      }),
    );
    expect(plan.held).toBe(DEFAULT_ALERTS_PER_DAY);
    expect(plan.overCap).toBe(1);
  });

  it.each([
    ['paid since the leak was found', guards({ paidAt: new Date('2026-11-09T00:00:00Z') }), 'paid'],
    ['asked to be deleted', guards({ deletedAt: new Date('2026-11-09T00:00:00Z') }), 'deleted'],
    ['opted out', guards({ optedOut: true }), 'opted out'],
  ])('never alerts about someone who %s', (_label, subject, reason) => {
    const plan = decideAlerts(policyInput({ guards: new Map([[1, subject]]) }));
    expect(plan.decisions[0]?.route).toBe('drop');
    expect(plan.decisions[0]?.because.toLowerCase()).toContain(reason);
    expect(plan.sending).toBe(0);
  });

  it('drops an alert whose person is no longer in the data at all', () => {
    const plan = decideAlerts(policyInput({ guards: new Map() }));
    expect(plan.decisions[0]?.route).toBe('drop');
    expect(plan.dropped).toBe(1);
  });

  it('still alerts about a paying customer for the two leaks that are about payers', () => {
    // `payer-going-quiet` is ABOUT having paid, so the paid guard must not fire.
    const paid = guards({ paidAt: new Date('2026-10-01T00:00:00Z') });
    const plan = decideAlerts(
      policyInput({
        candidates: [candidate('1', 'payer-going-quiet')],
        guards: new Map([[1, paid]]),
      }),
    );
    expect(plan.decisions[0]?.route).toBe('send');
  });

  it('keeps the count-only leaks out of the channel', () => {
    // Brief §8.3: the stall, the quick-exit rate and cancellations are counts.
    for (const leakType of [
      'onboarding-stall',
      'pricing-quick-exit',
      'cancelled-or-failed',
    ] as const) {
      const plan = decideAlerts(
        policyInput({
          candidates: [candidate('1', leakType)],
          guards: new Map([[1, guards({ paidAt: null })]]),
        }),
      );
      expect(plan.decisions[0]?.route, leakType).toBe('feed-only');
    }
  });

  it('puts everything in the feed when no chat app is connected', () => {
    const plan = decideAlerts(policyInput({ channel: 'none' }));
    expect(plan.decisions[0]?.route).toBe('feed-only');
    expect(plan.decisions[0]?.because).toContain('No alert channel');
  });

  it('points a digest-only founder at the digest rather than at nothing', () => {
    const plan = decideAlerts(policyInput({ channel: 'email-digest' }));
    expect(plan.decisions[0]?.route).toBe('feed-only');
    expect(plan.decisions[0]?.because).toContain('digest');
  });

  it('has no guards to check for a step, so a collapse always goes out', () => {
    const plan = decideAlerts(
      policyInput({ candidates: [candidate('1', 'step-collapse', 7)], guards: new Map() }),
    );
    expect(plan.decisions[0]?.route).toBe('send');
    // Brief §8.3: "unmasked because it concerns a step, not a person".
    expect(plan.decisions[0]?.masked).toBe(false);
  });
});

function alertFacts(over: Partial<AlertFacts> = {}): AlertFacts {
  return {
    leakType: 'high-intent-quiet',
    says: 'They reached 72 on buying intent and then went 8 days without doing anything.',
    who: 'User A7F2C1',
    masked: true,
    intentScore: 72,
    plan: 'Free',
    atStakeMinor: 4_900,
    atStakeCurrency: 'usd',
    when: 'this week',
    episode: 1,
    dashboardUrl: 'https://app.example.test/projects/abc/dashboard',
    ...over,
  };
}

describe('the alert payloads', () => {
  it('shows the detail the brief asks for and hides who', () => {
    const content = alertContent(alertFacts());
    const labels = content.fields.map((field) => field.label);
    // Brief §9: "leak type, intent score and band, plan and amount at stake, a
    // coarse time, the masked tag".
    expect(labels).toEqual(['Who (masked)', 'Buying intent', 'Plan', 'At stake', 'When']);
    expect(content.fields[0]?.value).toBe('User A7F2C1');
    expect(content.fields[1]?.value).toBe('72 of 100 · high');
    expect(content.fields[3]?.value).toBe('$49.00 at your list price');
    expect(content.rule).not.toBe('');
  });

  it('leaves out a fact it does not have rather than printing a dash', () => {
    const content = alertContent(
      alertFacts({ intentScore: null, plan: null, atStakeMinor: null, atStakeCurrency: null }),
    );
    expect(content.fields.map((f) => f.label)).toEqual(['Who (masked)', 'When']);
  });

  it('names the episode only when there has been more than one', () => {
    expect(alertContent(alertFacts()).fields.some((f) => f.label === 'Episode')).toBe(false);
    const third = alertContent(alertFacts({ episode: 3 }));
    expect(third.fields.find((f) => f.label === 'Episode')?.value).toBe('3rd time for them');
  });

  it('builds the Slack shape from the docs: text plus section blocks', () => {
    const payload = toSlack(alertContent(alertFacts()));

    // The docs' own advanced sample sets `text` alongside `blocks`; it is what a
    // phone notification shows.
    expect(payload.text).toContain('Someone with buying intent went quiet');
    expect(payload.blocks[0]).toMatchObject({
      type: 'section',
      text: { type: 'mrkdwn' },
    });

    const fieldsBlock = payload.blocks[1];
    expect(fieldsBlock).toBeDefined();
    if (fieldsBlock && 'fields' in fieldsBlock) {
      expect(fieldsBlock.fields.length).toBeLessThanOrEqual(SLACK_LIMITS.fieldsPerSection);
      expect(fieldsBlock.fields[0]).toEqual({
        type: 'mrkdwn',
        text: '*Who (masked)*\nUser A7F2C1',
      });
    }

    const context = payload.blocks[payload.blocks.length - 1];
    expect(context?.type).toBe('context');
  });

  it('keeps Slack’s documented maxima', () => {
    const long = 'x'.repeat(10_000);
    const payload = toSlack(alertContent(alertFacts({ says: long })));
    const first = payload.blocks[0];
    if (first && 'text' in first) {
      expect(first.text.text.length).toBeLessThanOrEqual(SLACK_LIMITS.sectionText);
    }
  });

  it('builds the Discord shape from the docs: username plus one embed', () => {
    const payload = toDiscord(alertContent(alertFacts()));
    expect(payload.username).toBe(WEBHOOK_USERNAME);
    expect(payload.embeds).toHaveLength(1);

    const embed = payload.embeds[0];
    expect(embed?.title).toBe('Someone with buying intent went quiet');
    expect(embed?.color).toBeTypeOf('number');
    expect(embed?.fields[0]).toEqual({
      name: 'Who (masked)',
      value: 'User A7F2C1',
      inline: true,
    });
    expect(embed?.footer.text).toContain('https://app.example.test');
  });

  it('carries no timestamp, because Discord would render it to the minute', () => {
    /*
     * The attack the coarse times exist to stop: a masked alert with a minute on it
     * can be matched against the founder's own server log or Stripe.
     */
    const payload = toDiscord(alertContent(alertFacts()));
    expect(payload.embeds[0]).not.toHaveProperty('timestamp');
    expect(JSON.stringify(payload)).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it('keeps Discord’s documented maxima, including the 6,000 across the message', () => {
    const payload = toDiscord(alertContent(alertFacts({ says: 'y'.repeat(20_000) })));
    const embed = payload.embeds[0];
    expect(embed).toBeDefined();
    if (!embed) return;

    expect(embed.title.length).toBeLessThanOrEqual(DISCORD_LIMITS.title);
    expect(embed.description.length).toBeLessThanOrEqual(DISCORD_LIMITS.description);
    expect(embed.fields.length).toBeLessThanOrEqual(DISCORD_LIMITS.fields);
    expect(embed.footer.text.length).toBeLessThanOrEqual(DISCORD_LIMITS.footerText);

    const total =
      embed.title.length +
      embed.description.length +
      embed.footer.text.length +
      embed.fields.reduce((n, f) => n + f.name.length + f.value.length, 0);
    expect(total).toBeLessThanOrEqual(DISCORD_LIMITS.total);
  });

  it('names the person on a paid project and labels the field accordingly', () => {
    const content = alertContent(alertFacts({ masked: false, who: 'jo@acme.test' }));
    expect(content.fields[0]).toEqual({ label: 'Who', value: 'jo@acme.test' });
    expect(content.masked).toBe(false);
  });
});

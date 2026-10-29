import { LEAK_DEFINITIONS_BY_TYPE, type LeakType } from '../leaks/types.js';
import { bandOf, type IntentBand } from '../intent/points.js';
import { formatMoney } from '../money.js';

/**
 * What an alert says, and the two shapes it is posted in (brief §9's Alerts).
 *
 * "Each alert shows what happened in real detail (leak type, intent score and band,
 * plan and amount at stake, a coarse time, the masked tag) and hides who."
 *
 * One neutral `AlertContent` is built first and then rendered to Slack's Block Kit
 * and Discord's embed. That order matters: it means a masked field cannot be masked
 * in one renderer and plain in the other, because neither renderer ever sees a name.
 * By the time a payload is built, `who` is already a tag or already a name, and the
 * decision was taken once, in the data-access layer.
 *
 * Both shapes are verified against the current docs (2026-10-29):
 *   - Slack incoming webhooks: `{ text, blocks }`, section blocks with `mrkdwn` text
 *     and a `fields` array of up to 10 items. text 1–3,000 chars, field item 2,000.
 *     https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks
 *   - Discord execute webhook: `{ username, content, embeds }`, up to 10 embeds;
 *     embed title 256, description 4,096, 25 fields, field name 256, field value
 *     1,024, footer text 2,048, and 6,000 characters across the whole message.
 *     https://docs.discord.com/developers/resources/webhook
 */

/** Slack's documented maxima, so a long leak sentence truncates instead of 400-ing. */
export const SLACK_LIMITS = {
  sectionText: 3_000,
  fieldsPerSection: 10,
  fieldText: 2_000,
} as const;

/** Discord's documented maxima. */
export const DISCORD_LIMITS = {
  content: 2_000,
  embeds: 10,
  title: 256,
  description: 4_096,
  fields: 25,
  fieldName: 256,
  fieldValue: 1_024,
  footerText: 2_048,
  total: 6_000,
} as const;

/** The name the webhook posts under, so a founder knows what is talking to them. */
export const WEBHOOK_USERNAME = 'Dripmetric';

/**
 * Discord wants a colour as an integer. Three, by how much the leak is worth acting
 * on today — not nine, because a colour per leak type is a legend nobody reads.
 */
export const DISCORD_COLOURS = {
  /** Money is leaving now: a checkout with no payment, a trial that just ended. */
  urgent: 0xd9_43_3f,
  /** Worth a look: intent gone quiet, a limit hit, a customer going quiet. */
  warn: 0xd9_8c_2f,
  /** A step broke. Not about a person, so it reads differently. */
  tracking: 0x3f_6f_d9,
} as const;

const URGENT_LEAKS: readonly LeakType[] = ['last-moment-drop', 'trial-ended-unpaid'];

/** The headline per leak, in the founder's words rather than the leak's slug. */
export const ALERT_TITLES: Record<LeakType, string> = {
  'last-moment-drop': 'Someone started checkout and did not pay',
  'high-intent-quiet': 'Someone with buying intent went quiet',
  'trial-ended-unpaid': 'A trial ended with no payment',
  'limit-reached-no-upgrade': 'Someone hit a plan limit and did not upgrade',
  'payer-going-quiet': 'A paying customer is going quiet',
  'step-collapse': 'A funnel step has stopped working',
  'onboarding-stall': 'Someone is stuck in onboarding',
  'cancelled-or-failed': 'A cancellation or a failed payment',
  'pricing-quick-exit': 'Someone glanced at pricing and left',
};

export interface AlertField {
  label: string;
  value: string;
}

/** What an alert says, before either channel's shape is applied. */
export interface AlertContent {
  leakType: LeakType;
  title: string;
  /** The leak's own stored sentence, which is what the feed shows too. */
  says: string;
  fields: AlertField[];
  /** The rule that produced it, so every number can show its working (rule 7). */
  rule: string;
  /** Where to see the rest. Null when no app URL is configured. */
  link: { url: string; label: string } | null;
  masked: boolean;
  urgency: keyof typeof DISCORD_COLOURS;
}

export interface AlertFacts {
  leakType: LeakType;
  /** The leak's stored sentence. */
  says: string;
  /**
   * Who it is about, already masked or already named by the data-access layer:
   * "User A7F2C1", "jo@acme.com", or "Step 2 · Connect a data source".
   */
  who: string;
  /** True when `who` is a tag rather than a person. Decided by `can()`, not here. */
  masked: boolean;
  /** Their peak intent score, when the leak is about a person. */
  intentScore: number | null;
  /** Their plan, when the founder sends one. */
  plan: string | null;
  /** The money at stake: the founder's list price, in minor units. */
  atStakeMinor: number | null;
  atStakeCurrency: string | null;
  /** "today" / "yesterday" / "this week" — never a timestamp for a masked person. */
  when: string;
  /** How many times this has happened to this subject. */
  episode: number;
  /** The dashboard URL, when one is configured. */
  dashboardUrl: string | null;
}

/**
 * Builds the alert.
 *
 * Every field is real or absent. Brief §9: "Every number and label is real. No
 * countdowns or deadlines that are not real." So there is no "act within 2 hours"
 * line, no fabricated urgency and no field with a dash in it — a fact we do not have
 * is a field that is not there.
 */
export function alertContent(facts: AlertFacts): AlertContent {
  const definition = LEAK_DEFINITIONS_BY_TYPE.get(facts.leakType);
  const fields: AlertField[] = [{ label: facts.masked ? 'Who (masked)' : 'Who', value: facts.who }];

  if (facts.intentScore !== null) {
    fields.push({
      label: 'Buying intent',
      value: `${facts.intentScore} of 100 · ${bandLabel(bandOf(facts.intentScore))}`,
    });
  }
  if (facts.plan !== null) fields.push({ label: 'Plan', value: facts.plan });
  if (facts.atStakeMinor !== null && facts.atStakeCurrency !== null) {
    fields.push({
      label: 'At stake',
      value: `${formatMoney(facts.atStakeMinor, facts.atStakeCurrency)} at your list price`,
    });
  }
  fields.push({ label: 'When', value: facts.when });
  if (facts.episode > 1) {
    fields.push({ label: 'Episode', value: `${ordinal(facts.episode)} time for them` });
  }

  return {
    leakType: facts.leakType,
    title: ALERT_TITLES[facts.leakType],
    says: facts.says,
    fields,
    rule: definition?.rule ?? '',
    link:
      facts.dashboardUrl === null
        ? null
        : { url: facts.dashboardUrl, label: 'See it on your dashboard' },
    masked: facts.masked,
    urgency: urgencyOf(facts.leakType),
  };
}

function urgencyOf(leakType: LeakType): keyof typeof DISCORD_COLOURS {
  if (leakType === 'step-collapse') return 'tracking';
  return URGENT_LEAKS.includes(leakType) ? 'urgent' : 'warn';
}

function bandLabel(band: IntentBand): string {
  return band === 'high' ? 'high' : band === 'warm' ? 'warm' : 'cold';
}

function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  const last = n % 10;
  return `${n}${last === 1 ? 'st' : last === 2 ? 'nd' : last === 3 ? 'rd' : 'th'}`;
}

// --- Slack ------------------------------------------------------------------

export interface SlackPayload {
  /** The notification line. Slack shows it where blocks cannot render. */
  text: string;
  blocks: SlackBlock[];
}

export type SlackBlock =
  | { type: 'section'; text: { type: 'mrkdwn'; text: string } }
  | { type: 'section'; fields: { type: 'mrkdwn'; text: string }[] }
  | { type: 'context'; elements: { type: 'mrkdwn'; text: string }[] }
  | { type: 'divider' };

/**
 * Block Kit.
 *
 * `text` is set as well as `blocks`, which the docs' own advanced sample does: it is
 * what a phone's notification shows and what a client that cannot render blocks falls
 * back to. An alert whose push notification reads "This content can't be displayed"
 * is an alert that did not arrive.
 */
export function toSlack(content: AlertContent): SlackPayload {
  const blocks: SlackBlock[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: clip(`*${content.title}*\n${content.says}`, SLACK_LIMITS.sectionText),
      },
    },
  ];

  // Two side-by-side columns, which is what a `fields` array renders as.
  const fields = content.fields.slice(0, SLACK_LIMITS.fieldsPerSection).map((field) => ({
    type: 'mrkdwn' as const,
    text: clip(`*${field.label}*\n${field.value}`, SLACK_LIMITS.fieldText),
  }));
  if (fields.length > 0) blocks.push({ type: 'section', fields });

  const footer = [content.rule];
  if (content.link !== null) footer.push(`<${content.link.url}|${content.link.label}>`);
  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: clip(footer.join('\n'), SLACK_LIMITS.fieldText) }],
  });

  return { text: `${content.title} — ${content.says}`, blocks };
}

// --- Discord ----------------------------------------------------------------

export interface DiscordPayload {
  username: string;
  embeds: DiscordEmbed[];
}

export interface DiscordEmbed {
  title: string;
  description: string;
  color: number;
  fields: { name: string; value: string; inline: boolean }[];
  footer: { text: string };
}

/**
 * One embed, inside the documented limits.
 *
 * No `timestamp`, deliberately. Discord renders it to the minute in the viewer's own
 * zone, and a masked alert with a minute on it can be matched against the founder's
 * server log or Stripe — which is the attack the coarse times exist to prevent
 * (brief §9). The `When` field carries "today" or "this week" instead.
 */
export function toDiscord(content: AlertContent): DiscordPayload {
  const embed: DiscordEmbed = {
    title: clip(content.title, DISCORD_LIMITS.title),
    description: clip(content.says, DISCORD_LIMITS.description),
    color: DISCORD_COLOURS[content.urgency],
    fields: content.fields.slice(0, DISCORD_LIMITS.fields).map((field) => ({
      name: clip(field.label, DISCORD_LIMITS.fieldName),
      value: clip(field.value, DISCORD_LIMITS.fieldValue),
      inline: true,
    })),
    footer: {
      text: clip(
        content.link === null ? content.rule : `${content.rule}\n${content.link.url}`,
        DISCORD_LIMITS.footerText,
      ),
    },
  };

  return { username: WEBHOOK_USERNAME, embeds: [trimToTotal(embed)] };
}

/**
 * Discord counts 6,000 characters across the whole message and returns 400 for 6,001.
 *
 * The description is what gets shortened, because it is the only field here that has
 * no fixed length: a leak sentence is as long as the founder's own step labels make
 * it. Dropping fields instead would lose the numbers, which are the point.
 */
function trimToTotal(embed: DiscordEmbed): DiscordEmbed {
  const fixed =
    embed.title.length +
    embed.footer.text.length +
    embed.fields.reduce((n, field) => n + field.name.length + field.value.length, 0);
  const room = DISCORD_LIMITS.total - fixed;
  if (embed.description.length <= room) return embed;
  return { ...embed, description: clip(embed.description, Math.max(0, room)) };
}

/** Truncates with an ellipsis, so a clipped value looks clipped rather than wrong. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 1) return text.slice(0, max);
  return `${text.slice(0, max - 1)}…`;
}

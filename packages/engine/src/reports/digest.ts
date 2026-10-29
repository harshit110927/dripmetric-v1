import { LEAK_DEFINITIONS_BY_TYPE, type LeakType } from '../leaks/types.js';
import { ALERT_TITLES } from '../alerts/payload.js';
import { plural } from '../money.js';

/**
 * The daily email digest (brief §9's Alerts).
 *
 * "Founders with neither chat app get one email digest a day, only on days with
 * alerts."
 *
 * Both halves of that sentence are rules. It replaces instant alerts rather than
 * adding to them, so a founder on Slack never gets one; and a day with nothing on it
 * produces no email at all, which is why `digest()` can return null.
 */

export interface DigestItem {
  leakType: LeakType;
  /** The leak's stored sentence, already masked or already named upstream. */
  says: string;
  /** "today" / "this week": coarse, like every masked time (brief §9). */
  when: string;
}

export interface DigestFacts {
  projectName: string;
  /** The founder's local date, as they would write it. */
  dayLabel: string;
  items: readonly DigestItem[];
  /** Alerts that went to the feed only because the daily cap was reached. */
  overCap: number;
  dashboardUrl: string | null;
  unsubscribeUrl: string | null;
}

export interface Digest {
  subject: string;
  text: string;
}

/** The most items an email lists before it becomes a wall. The rest are a count. */
export const DIGEST_ITEM_LIMIT = 12;

export function digest(facts: DigestFacts): Digest | null {
  // "Only on days with alerts."
  if (facts.items.length === 0) return null;

  const shown = facts.items.slice(0, DIGEST_ITEM_LIMIT);
  const hidden = facts.items.length - shown.length;

  /*
   * Grouped by leak, not listed one by one.
   *
   * Eleven lines each beginning "Someone started checkout and did not pay" is not a
   * digest, it is the same alert eleven times. The heading carries the count and the
   * sentences sit under it.
   */
  const groups = new Map<LeakType, DigestItem[]>();
  for (const item of shown) {
    const existing = groups.get(item.leakType);
    if (existing) existing.push(item);
    else groups.set(item.leakType, [item]);
  }

  const blocks: string[] = [];
  for (const [leakType, items] of groups) {
    const title = ALERT_TITLES[leakType];
    const rule = LEAK_DEFINITIONS_BY_TYPE.get(leakType)?.rule ?? '';
    blocks.push(
      [
        `${title} — ${plural(items.length, 'time')}`,
        ...items.map((item) => `  · ${item.says} (${item.when})`),
        rule === '' ? '' : `  Rule: ${rule}`,
      ]
        .filter((line) => line !== '')
        .join('\n'),
    );
  }

  if (hidden > 0) blocks.push(`And ${plural(hidden, 'more')} in your feed.`);
  if (facts.overCap > 0) {
    blocks.push(
      `${plural(facts.overCap, 'alert')} went to your feed only, because today reached the daily limit.`,
    );
  }
  if (facts.dashboardUrl !== null) blocks.push(`Your dashboard: ${facts.dashboardUrl}`);
  if (facts.unsubscribeUrl !== null) {
    blocks.push(`Stop these emails in one click: ${facts.unsubscribeUrl}`);
  }

  return {
    subject: `${plural(facts.items.length, 'leak')} on ${facts.projectName} — ${facts.dayLabel}`,
    text: blocks.join('\n\n'),
  };
}

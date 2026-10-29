import { plural } from '../money.js';

/**
 * Watching the tracking itself (brief §9's Tracking health).
 *
 * "Silent breakage is the fastest way to lose a founder's trust in the numbers."
 *
 * Every check here returns a finding whose sentence blames the TRACKING, never the
 * users. That is the brief's own requirement and it is the hard part: a `Signed Up`
 * that stops arriving is indistinguishable, in the data, from nobody signing up. The
 * difference is the baseline — and saying "your signups went to zero" when a deploy
 * broke the snippet is exactly how a founder stops believing the dashboard.
 */

export const FINDING_KINDS = [
  'missing-event',
  'shape-drift',
  'double-sent',
  'late-events',
  'source-share',
] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];

export interface HealthFinding {
  kind: FindingKind;
  /** The event name, `name.property`, or source path this is about. */
  subject: string;
  /** What makes this one episode, so a sweep cannot re-raise it (brief §8.3's shape). */
  episodeKey: string;
  detectedAt: Date;
  says: string;
  /** What to do, in the founder's words. */
  fix: string;
  details: Record<string, unknown>;
}

// --- Missing events --------------------------------------------------------

/**
 * Brief §9: "an event that normally arrives stops (for example no Signed Up for 24
 * hours against a baseline of 5 a day)."
 *
 * The baseline is per event and comes from the founder's own history, so a product
 * that gets five signups a day and one that gets five hundred both get a useful
 * answer, and neither gets alerted for a quiet Sunday.
 */
export const MISSING_EVENT_HOURS = 24;
/** Below this, a day's silence is ordinary. Two a day is not a baseline. */
export const MISSING_EVENT_MIN_BASELINE = 3;
/** Days of history the baseline is averaged over. */
export const BASELINE_DAYS = 14;

export interface EventRateFact {
  name: string;
  /** Events in the last `MISSING_EVENT_HOURS`. */
  recent: number;
  /** Average per day over the baseline window, excluding the recent window. */
  baselinePerDay: number;
  /** When it was last seen at all. Null if never. */
  lastSeenAt: Date | null;
  /** True for an event the founder's checklist says matters. */
  onChecklist: boolean;
}

export function missingEvents(facts: readonly EventRateFact[], now: Date): HealthFinding[] {
  const findings: HealthFinding[] = [];

  for (const fact of facts) {
    if (fact.recent > 0) continue;
    if (fact.baselinePerDay < MISSING_EVENT_MIN_BASELINE) continue;
    if (fact.lastSeenAt === null) continue;

    const hoursQuiet = Math.floor((now.getTime() - fact.lastSeenAt.getTime()) / 3_600_000);
    const expected = Math.round(fact.baselinePerDay);

    findings.push({
      kind: 'missing-event',
      subject: fact.name,
      /*
       * Keyed on the DAY it went quiet, not on `now`.
       *
       * A sweep every five minutes would otherwise raise a new finding every five
       * minutes for the same outage. The day it stopped is a fact about the past, so
       * it stays the same until the event comes back — and if it stops again next
       * week, that is a different key and a new finding, correctly.
       */
      episodeKey: `quiet:${fact.lastSeenAt.toISOString().slice(0, 10)}`,
      detectedAt: fact.lastSeenAt,
      says:
        `No "${fact.name}" has arrived for ${plural(hoursQuiet, 'hour')}, ` +
        `against a normal ${plural(expected, 'a day', 'a day')}. ` +
        `This looks like tracking that stopped, not people who stopped.`,
      fix:
        `Check that the code sending "${fact.name}" still runs — a deploy, a renamed ` +
        `event, a rotated key or a blocked script all look like this.`,
      details: {
        hoursQuiet,
        baselinePerDay: fact.baselinePerDay,
        lastSeenAt: fact.lastSeenAt.toISOString(),
        window: `${MISSING_EVENT_HOURS}h`,
      },
    });
  }

  return findings;
}

// --- Shape drift -----------------------------------------------------------

/** How many events must have carried the old type before a change is worth saying. */
export const SHAPE_DRIFT_MIN_PRIOR = 20;
/**
 * A property that appears this long after its event was first seen is "new on a
 * known event" rather than part of the original shape.
 */
export const NEW_PROPERTY_GRACE_DAYS = 7;

export interface PropertyShapeFact {
  eventName: string;
  property: string;
  valueType: string;
  priorValueType: string | null;
  priorSeenCount: number;
  typeChangedAt: Date | null;
  /** When this property was first seen. */
  firstSeenAt: Date;
  /** When its event was first seen. */
  eventFirstSeenAt: Date;
  seenCount: number;
}

export function shapeDrift(facts: readonly PropertyShapeFact[]): HealthFinding[] {
  const findings: HealthFinding[] = [];

  for (const fact of facts) {
    // A property that changed type.
    if (
      fact.priorValueType !== null &&
      fact.priorValueType !== fact.valueType &&
      fact.typeChangedAt !== null &&
      fact.priorSeenCount >= SHAPE_DRIFT_MIN_PRIOR
    ) {
      findings.push({
        kind: 'shape-drift',
        subject: `${fact.eventName}.${fact.property}`,
        episodeKey: `type:${fact.priorValueType}->${fact.valueType}`,
        detectedAt: fact.typeChangedAt,
        says:
          `"${fact.property}" on "${fact.eventName}" used to be a ${fact.priorValueType} ` +
          `and is now a ${fact.valueType}.`,
        fix:
          `If that was deliberate, nothing is broken — but anything that read it as a ` +
          `${fact.priorValueType} will have stopped matching.`,
        details: {
          from: fact.priorValueType,
          to: fact.valueType,
          eventsWithOldType: fact.priorSeenCount,
          changedAt: fact.typeChangedAt.toISOString(),
        },
      });
      continue;
    }

    // A new property on an event we have known for a while.
    const appearedAfter =
      (fact.firstSeenAt.getTime() - fact.eventFirstSeenAt.getTime()) / 86_400_000;
    if (appearedAfter >= NEW_PROPERTY_GRACE_DAYS) {
      findings.push({
        kind: 'shape-drift',
        subject: `${fact.eventName}.${fact.property}`,
        episodeKey: `new:${fact.firstSeenAt.toISOString().slice(0, 10)}`,
        detectedAt: fact.firstSeenAt,
        says:
          `"${fact.eventName}" started carrying a new property, "${fact.property}" ` +
          `(${fact.valueType}), ${Math.round(appearedAfter)} days after we first saw the event.`,
        fix: 'Worth a look only if you did not add it on purpose.',
        details: {
          property: fact.property,
          valueType: fact.valueType,
          daysAfterEvent: Math.round(appearedAfter),
        },
      });
    }
  }

  return findings;
}

// --- Double-sent -----------------------------------------------------------

/**
 * Brief §9: "Double-sent events (two source paths sending the same event)."
 *
 * The signal is the same person, the same event name and the same second arriving
 * from two different source paths — which is what happens when a founder adds the
 * server SDK without removing the browser call.
 */
export const DOUBLE_SENT_MIN_PAIRS = 10;
/** Below this share it is coincidence: two people can act in the same second. */
export const DOUBLE_SENT_MIN_SHARE = 0.05;

export interface DoubleSentFact {
  name: string;
  /** Distinct (user, second) pairs seen from more than one source. */
  pairs: number;
  /** All events of this name in the window. */
  total: number;
  sources: string[];
}

export function doubleSent(facts: readonly DoubleSentFact[], now: Date): HealthFinding[] {
  const findings: HealthFinding[] = [];

  for (const fact of facts) {
    if (fact.pairs < DOUBLE_SENT_MIN_PAIRS) continue;
    const share = fact.total === 0 ? 0 : fact.pairs / fact.total;
    if (share < DOUBLE_SENT_MIN_SHARE) continue;

    findings.push({
      kind: 'double-sent',
      subject: fact.name,
      // Keyed on the source pair: adding a third path is a new finding.
      episodeKey: `sources:${[...fact.sources].sort().join('+')}`,
      detectedAt: now,
      says:
        `"${fact.name}" is arriving from ${plural(fact.sources.length, 'place')} at once ` +
        `(${fact.sources.join(' and ')}). ${plural(fact.pairs, 'event')} look like duplicates, ` +
        `which is ${(share * 100).toFixed(1)}% of them.`,
      fix:
        `Send it from one place. Until then counts for "${fact.name}" are high, and so ` +
        `is anything built on them.`,
      details: { pairs: fact.pairs, total: fact.total, share, sources: fact.sources },
    });
  }

  return findings;
}

// --- Late events and the source share -------------------------------------

/** Above this share of late arrivals, a source path is worth mentioning. */
export const LATE_SHARE_THRESHOLD = 0.2;
export const LATE_MIN_EVENTS = 50;

export interface LateFact {
  source: string;
  late: number;
  total: number;
}

export function lateEvents(facts: readonly LateFact[], now: Date): HealthFinding[] {
  const findings: HealthFinding[] = [];

  for (const fact of facts) {
    if (fact.total < LATE_MIN_EVENTS) continue;
    const share = fact.late / fact.total;
    if (share < LATE_SHARE_THRESHOLD) continue;

    findings.push({
      kind: 'late-events',
      subject: fact.source,
      // Keyed to the week, so this is a weekly nudge and not a five-minute one.
      episodeKey: `late:${weekKey(now)}`,
      detectedAt: now,
      says:
        `${(share * 100).toFixed(0)}% of events from ${fact.source} are arriving after ` +
        `the fact. They are counted at their own timestamps, so the numbers are right — ` +
        `but anything in the last hour may still be filling in.`,
      fix: 'Usually a queue, a retry or a mobile client that was offline. Not a bug by itself.',
      details: { late: fact.late, total: fact.total, share },
    });
  }

  return findings;
}

/**
 * Brief §9: "Browser against server share of events, so blocked page views are a
 * known gap and not a silent one."
 *
 * The check is for a COLLAPSE against the project's own history, not a fixed ratio: a
 * server-only product legitimately sends no browser events at all, and telling that
 * founder their page views are blocked every night would be noise.
 */
export const SOURCE_COLLAPSE_RATIO = 0.4;
export const SOURCE_MIN_BASELINE = 100;

export interface SourceShareFact {
  /** Browser events in the recent window. */
  browserRecent: number;
  /** Browser events per day over the baseline. */
  browserBaselinePerDay: number;
  serverRecent: number;
}

export function sourceShareCollapse(fact: SourceShareFact, now: Date): HealthFinding | null {
  if (fact.browserBaselinePerDay < SOURCE_MIN_BASELINE) return null;
  const expected = fact.browserBaselinePerDay;
  if (fact.browserRecent >= expected * SOURCE_COLLAPSE_RATIO) return null;

  // Server events still arriving is what makes this "blocked", not "quiet".
  const stillLive = fact.serverRecent > 0;

  return {
    kind: 'source-share',
    subject: 'browser',
    episodeKey: `collapse:${now.toISOString().slice(0, 10)}`,
    detectedAt: now,
    says:
      `Browser events are down to ${fact.browserRecent} today against a normal ` +
      `${Math.round(expected)} a day` +
      (stillLive ? ', while your server events are arriving as usual.' : '.') +
      ' That gap is blocked or broken page views, not quieter users.',
    fix: stillLive
      ? 'Check the snippet still loads: a consent banner, an ad blocker or a CSP change all do this.'
      : 'Both paths are quiet, so check the key and the host before the snippet.',
    details: {
      browserRecent: fact.browserRecent,
      browserBaselinePerDay: expected,
      serverRecent: fact.serverRecent,
    },
  };
}

/** ISO-ish week key, for findings that should nudge weekly rather than hourly. */
function weekKey(at: Date): string {
  const monday = new Date(at);
  const day = monday.getUTCDay();
  monday.setUTCDate(monday.getUTCDate() - ((day + 6) % 7));
  return monday.toISOString().slice(0, 10);
}

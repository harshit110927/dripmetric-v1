import type { MessageInput } from '@dripmetric/catalog';

/**
 * Turning a no-code feed into our own messages (brief §5, M12).
 *
 * The exit check is that "recorded Segment/RudderStack/PostHog payloads produce the
 * SAME canonical events as native SDK sends", which is only meaningful because these
 * functions are the only difference between the paths: after normalising, every feed
 * goes through the same `handleBatch` as the SDK, so there is one pipeline and one set
 * of rules about what an event means.
 */

export type AdapterSource = 'segment' | 'rudderstack' | 'posthog';

export interface NormaliseResult {
  messages: MessageInput[];
  /** Dropped on purpose, by reason, so the founder can be shown a count. */
  dropped: { reason: string; count: number }[];
}

function countDrop(dropped: Map<string, number>, reason: string): void {
  dropped.set(reason, (dropped.get(reason) ?? 0) + 1);
}

function asResult(messages: MessageInput[], dropped: Map<string, number>): NormaliseResult {
  return {
    messages,
    dropped: [...dropped.entries()].map(([reason, count]) => ({ reason, count })),
  };
}

// --- Segment and RudderStack ----------------------------------------------

/**
 * Both speak Segment's spec, so one function reads both.
 *
 * RudderStack was built as a drop-in for Segment's API and forwards the same
 * `type`/`event`/`properties`/`traits` shape. Writing two near-identical adapters
 * would be two places for the same bug, so the SOURCE is what differs and the
 * reading does not.
 */
export function normaliseSegmentLike(body: unknown, source: AdapterSource): NormaliseResult {
  const dropped = new Map<string, number>();
  const messages: MessageInput[] = [];

  for (const raw of eventsOf(body)) {
    if (typeof raw !== 'object' || raw === null) {
      countDrop(dropped, 'not an object');
      continue;
    }
    const event = raw as Record<string, unknown>;
    const type = typeof event['type'] === 'string' ? event['type'] : null;

    if (type === null) {
      countDrop(dropped, 'no message type');
      continue;
    }
    // `alias` and `screen` have no meaning for us; dropping them is not an error.
    if (!['track', 'page', 'identify', 'group'].includes(type)) {
      countDrop(dropped, `unsupported type: ${type}`);
      continue;
    }

    const userId = stringOrNull(event['userId']);
    const anonymousId = stringOrNull(event['anonymousId']);
    if (userId === null && anonymousId === null) {
      countDrop(dropped, 'no userId and no anonymousId');
      continue;
    }

    const base = {
      type,
      messageId: stringOrNull(event['messageId']) ?? undefined,
      timestamp: stringOrNull(event['timestamp']) ?? undefined,
      ...(userId === null ? {} : { userId }),
      ...(anonymousId === null ? {} : { anonymousId }),
      /*
       * The source is stamped here, not guessed later.
       *
       * It is what makes "two source paths sending the same event" detectable
       * (M11's double-sent check) and what the double-path warning reads.
       */
      _source: source,
      context: contextOf(event),
    };

    if (type === 'track') {
      const name = stringOrNull(event['event']);
      if (name === null) {
        countDrop(dropped, 'track with no event name');
        continue;
      }
      messages.push({
        ...base,
        event: name,
        properties: objectOf(event['properties']),
      } as MessageInput);
      continue;
    }

    if (type === 'page') {
      messages.push({
        ...base,
        ...(stringOrNull(event['name']) === null ? {} : { name: stringOrNull(event['name']) }),
        properties: objectOf(event['properties']),
      } as MessageInput);
      continue;
    }

    if (type === 'identify') {
      messages.push({ ...base, traits: objectOf(event['traits']) } as MessageInput);
      continue;
    }

    const groupId = stringOrNull(event['groupId']);
    if (groupId === null) {
      countDrop(dropped, 'group with no groupId');
      continue;
    }
    messages.push({ ...base, groupId, traits: objectOf(event['traits']) } as MessageInput);
  }

  return asResult(messages, dropped);
}

// --- PostHog ---------------------------------------------------------------

/**
 * The PostHog allow-list (brief §5, M12's exit check).
 *
 * PostHog's autocapture sends an event for every click and input, and forwarding all
 * of it would fill a founder's dictionary with `$autocapture` noise and their event
 * counts with things they never chose to track. So nothing is accepted unless it is
 * on this list: `$pageview` and `$pageleave` map onto our page messages, `$identify`
 * and `$set` onto identify, `$groupidentify` onto group, and a NAMED custom event
 * (anything not starting with `$`) is a track.
 *
 * Deny-by-default rather than a list of things to drop: PostHog can add a new
 * `$`-prefixed event whenever it likes, and a drop-list would silently start
 * accepting it.
 */
export const POSTHOG_ALLOWED = new Set([
  '$pageview',
  '$pageleave',
  '$identify',
  '$set',
  '$groupidentify',
]);

/** PostHog properties that are its own plumbing rather than the founder's data. */
const POSTHOG_INTERNAL_PREFIX = '$';

export function normalisePostHog(body: unknown): NormaliseResult {
  const dropped = new Map<string, number>();
  const messages: MessageInput[] = [];

  for (const raw of eventsOf(body)) {
    if (typeof raw !== 'object' || raw === null) {
      countDrop(dropped, 'not an object');
      continue;
    }
    const event = raw as Record<string, unknown>;
    const name = stringOrNull(event['event']);
    const distinctId = stringOrNull(event['distinct_id']);

    if (name === null) {
      countDrop(dropped, 'no event name');
      continue;
    }
    if (distinctId === null) {
      countDrop(dropped, 'no distinct_id');
      continue;
    }

    const internal = name.startsWith(POSTHOG_INTERNAL_PREFIX);
    if (internal && !POSTHOG_ALLOWED.has(name)) {
      // Counted, not silent: the founder is shown how much was discarded.
      countDrop(dropped, `not on the allow-list: ${name}`);
      continue;
    }

    const properties = objectOf(event['properties']);
    const base = {
      messageId: stringOrNull(event['uuid']) ?? undefined,
      timestamp: stringOrNull(event['timestamp']) ?? undefined,
      /*
       * PostHog has one id field, and whether it is a user or an anonymous visitor
       * depends on whether the founder has called identify. An id that looks
       * anonymous is treated as anonymous, because getting it wrong the other way
       * would merge strangers into one person.
       */
      ...(looksAnonymous(distinctId) ? { anonymousId: distinctId } : { userId: distinctId }),
      _source: 'posthog' as const,
      context: postHogContext(properties),
    };

    if (name === '$pageview' || name === '$pageleave') {
      messages.push({
        ...base,
        type: 'page',
        name: name === '$pageview' ? 'Page Viewed' : 'Page Left',
        properties: founderProperties(properties),
      } as MessageInput);
      continue;
    }

    if (name === '$identify' || name === '$set') {
      messages.push({
        ...base,
        type: 'identify',
        traits: {
          ...founderProperties(objectOf(properties['$set'])),
          ...founderProperties(properties),
        },
      } as MessageInput);
      continue;
    }

    if (name === '$groupidentify') {
      const groupId = stringOrNull(properties['$group_key']);
      if (groupId === null) {
        countDrop(dropped, '$groupidentify with no $group_key');
        continue;
      }
      messages.push({
        ...base,
        type: 'group',
        groupId,
        traits: founderProperties(objectOf(properties['$group_set'])),
      } as MessageInput);
      continue;
    }

    messages.push({
      ...base,
      type: 'track',
      event: name,
      properties: founderProperties(properties),
    } as MessageInput);
  }

  return asResult(messages, dropped);
}

/**
 * An id PostHog generated for someone it does not know.
 *
 * Its anonymous ids are UUIDs; a founder's own user id rarely is. Treating a UUID as
 * anonymous is the safe mistake — an anonymous visitor who later identifies is linked
 * by the pipeline anyway, whereas treating many anonymous ids as user ids would
 * invent people.
 */
function looksAnonymous(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

/** PostHog's `$`-prefixed plumbing, read into our own context shape. */
function postHogContext(properties: Record<string, unknown>): Record<string, unknown> {
  const url = stringOrNull(properties['$current_url']);
  const context: Record<string, unknown> = {};

  if (url !== null) {
    try {
      const parsed = new URL(url);
      context['page'] = { path: parsed.pathname, url, search: parsed.search };
    } catch {
      context['page'] = { url };
    }
  }
  const referrer = stringOrNull(properties['$referrer']);
  if (referrer !== null) {
    context['page'] = { ...(context['page'] as object | undefined), referrer };
  }
  const sessionId = stringOrNull(properties['$session_id']);
  if (sessionId !== null) context['sessionId'] = sessionId;

  return context;
}

/** Everything that is not PostHog's own plumbing. */
function founderProperties(properties: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (key.startsWith(POSTHOG_INTERNAL_PREFIX)) continue;
    out[key] = value;
  }
  return out;
}

// --- Shared --------------------------------------------------------------

/** A body that is an array, a `{ batch: [...] }`, or one event on its own. */
function eventsOf(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  if (typeof body === 'object' && body !== null) {
    const batch = (body as { batch?: unknown }).batch;
    if (Array.isArray(batch)) return batch;
    return [body];
  }
  return [];
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function objectOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function contextOf(event: Record<string, unknown>): Record<string, unknown> {
  return objectOf(event['context']);
}

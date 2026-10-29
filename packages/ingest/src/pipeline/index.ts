import {
  CATALOG_EVENTS_BY_NAME,
  isCanonicalEventName,
  SERVER_ONLY_EVENT_NAMES,
  SERVER_ONLY_TRAITS,
  type MessageInput,
  type MessageResult,
  type Source,
} from '@dripmetric/catalog';
import type { ScopedDb } from '@dripmetric/db';
import type { PreparedMessage } from '../types.js';
import { isBot, visitorUserAgent } from '../enrich/user-agent.js';
import { emailDomain, looksLikeEmail } from '../enrich/email.js';
import { normalisePath } from '../enrich/paths.js';
import {
  countName,
  flushNameCounts,
  newNameCache,
  resolveNameId,
  resolvePathId,
  type NameCache,
  type NameCounts,
} from './names.js';
import {
  addAccountMember,
  applyTraits,
  linkAnonymousToUser,
  markInternal,
  resolveAccount,
  resolveAnonKey,
  resolveUserKey,
  type ResolvedUser,
} from './identity.js';
import {
  addToSession,
  ensureSession,
  flushSessionTotals,
  latestBrowserSession,
  type SessionTotalsMap,
} from './sessions.js';
import {
  readDailyCounts,
  recordMonthlyActive,
  updatePageLeftTotals,
  writeDailyCounts,
  writeEvents,
  type DailyCountDelta,
  type EventWrite,
} from './events.js';
import {
  applyStepUpdates,
  EMPTY_FUNNEL,
  loadFunnel,
  matchSteps,
  type FunnelConfig,
  type StepUpdate,
} from './step-state.js';

/**
 * The pipeline, identical for every source (brief section 5).
 *
 * It runs in two phases, which is what makes it fast enough to sit in a request:
 *
 *   **prepare** — per message: filter, enrich, resolve identity, session, event name
 *   and path, then build the row. Every lookup is cached for the batch, so a batch of
 *   1,000 events from 100 people costs 100 user lookups, not 1,000.
 *
 *   **flush** — once per batch: one multi-row insert for the events, one for step
 *   state, one for the tracked-user rows, one for the daily counters. The insert's
 *   RETURNING clause says which rows actually landed, so duplicates are reported as
 *   facts rather than guesses.
 */

export interface ProjectContext {
  projectId: number;
  /** Secret keys may set server-only traits and send billing events; browsers may not. */
  allowServerOnly: boolean;
  source: Source;
  internalDomains: readonly string[];
  internalEmails: readonly string[];
  dailyRowsPerUserPerEvent: number;
  /** From the platform's IP-country header. The IP itself is never stored. */
  country: string | null;
  userAgent: string | undefined;
}

export interface FollowUp {
  job: 'recompute-intent' | 'check-leaks' | 'tracking-health';
  userKey: number;
}

/** A message that got as far as a row waiting to be written. */
interface PendingEvent {
  /** Its position in the batch, so the reply lists results in the order they came. */
  index: number;
  messageId: string;
  write: EventWrite;
  /** Page Left updates an existing row rather than being dropped as a duplicate. */
  isPageLeft: boolean;
  steps: StepUpdate[];
}

export interface PipelineState {
  names: NameCache;
  /** How many times each name appeared in this batch; flushed once at the end. */
  nameCounts: NameCounts;
  paths: Map<string, number>;
  users: Map<string, ResolvedUser>;
  anons: Map<string, number>;
  sessions: Map<string, number>;
  /** `${userKey}:${month}` — a person is recorded once per month, not once per event. */
  monthlyActive: Set<string>;
  /** Per session: its last event, page views and active seconds, flushed once. */
  sessionTotals: SessionTotalsMap;
  /**
   * `${day}:${userKey}:${nameId}` — `base` is what the database already held and
   * `batch` is what this batch added, INCLUDING the rows that went over the cap.
   * The cap is a volume guard, so the counters have to count what arrived, not what
   * was stored.
   */
  arrivedToday: Map<string, { base: number; batch: number }>;
  funnel: FunnelConfig | null;
  pending: PendingEvent[];
  followUps: FollowUp[];
}

export function newPipelineState(): PipelineState {
  return {
    names: newNameCache(),
    nameCounts: new Map(),
    paths: new Map(),
    users: new Map(),
    anons: new Map(),
    sessions: new Map(),
    sessionTotals: new Map(),
    monthlyActive: new Set(),
    arrivedToday: new Map(),
    funnel: null,
    pending: [],
    followUps: [],
  };
}

/** Phase one. Returns a result when the message is settled, or null when it is queued. */
export async function prepareForWrite(
  db: ScopedDb,
  index: number,
  prepared: PreparedMessage,
  project: ProjectContext,
  state: PipelineState,
  receivedAt: Date,
): Promise<MessageResult | null> {
  const message = prepared.input;
  const ok = (message_?: string): MessageResult => ({
    messageId: prepared.messageId,
    status: 'ok',
    code: 'ok',
    ...(message_ ? { message: message_ } : {}),
  });
  const filtered = (code: MessageResult['code'], why: string): MessageResult => ({
    messageId: prepared.messageId,
    status: 'filtered',
    code,
    message: why,
  });

  // --- Step 4: drop bots, internal users and anyone opted out ------------------
  if (isBot(visitorUserAgent(message.context?.userAgent, project.userAgent))) {
    return filtered('bot_filtered', 'This looks like a crawler, so it is not counted.');
  }

  // Accepted so a Segment source does not break, but nothing reads them.
  if (message.type === 'screen' || message.type === 'alias') return ok('Accepted and ignored.');

  // A visitor must not be able to forge a payment (brief section 5).
  if (
    message.type === 'track' &&
    !project.allowServerOnly &&
    SERVER_ONLY_EVENT_NAMES.has(message.event)
  ) {
    return {
      messageId: prepared.messageId,
      status: 'error',
      code: 'server_only_event',
      message: `"${message.event}" can only be sent with a secret key, from your server.`,
    };
  }

  // --- Step 6: resolve identity ------------------------------------------------
  let anonKey: number | null = null;
  if (message.anonymousId) {
    const cached = state.anons.get(message.anonymousId);
    anonKey = cached ?? (await resolveAnonKey(db, message.anonymousId, prepared.occurredAt));
    state.anons.set(message.anonymousId, anonKey);
  }

  let userKey: number | null = null;
  if (message.userId) {
    let user = state.users.get(message.userId);
    if (!user) {
      user = await resolveUserKey(db, message.userId, prepared.occurredAt);
      state.users.set(message.userId, user);
    }
    if (user.deleted) return filtered('opted_out', 'This person asked to be deleted.');
    if (user.internal) return filtered('internal_filtered', 'This is one of your own team.');
    userKey = user.userKey;

    if (anonKey !== null) {
      await linkAnonymousToUser(db, anonKey, userKey, prepared.occurredAt);
    }
  }

  // --- Traits ------------------------------------------------------------------
  if (message.type === 'identify' && userKey !== null && message.traits) {
    const traits = message.traits;

    // The founder's own team, by domain or by address (brief section 5, step 4).
    const email = traits['email'];
    if (looksLikeEmail(email) && isInternal(email, project)) {
      // Also removes anything already stored for them: an event can arrive BEFORE
      // the identify that reveals who they are (see markInternal).
      await markInternal(db, userKey);
      state.users.set(message.userId!, {
        userKey,
        internal: true,
        optedOut: false,
        deleted: false,
      });

      // Rows queued earlier in THIS batch for the same person must not be written.
      for (let i = state.pending.length - 1; i >= 0; i--) {
        if (state.pending[i]?.write.userKey === userKey) state.pending.splice(i, 1);
      }
      return filtered('internal_filtered', 'This address is on your internal list.');
    }

    if (!project.allowServerOnly) {
      for (const key of Object.keys(traits)) {
        if (SERVER_ONLY_TRAITS.has(key)) {
          return {
            messageId: prepared.messageId,
            status: 'error',
            code: 'server_only_trait',
            message: `"${key}" can only be set with a secret key, from your server.`,
          };
        }
      }
    }

    await applyTraits(db, userKey, traits, prepared.occurredAt, {
      allowServerOnly: project.allowServerOnly,
    });
  }

  if (message.type === 'group' && userKey !== null) {
    const traits = message.traits ?? {};
    const accountId = await resolveAccount(db, message.groupId, traits, prepared.occurredAt);
    await addAccountMember(db, accountId, userKey, traits, prepared.occurredAt);
    return ok();
  }

  // --- Step 5: the session carries the context, once ---------------------------
  const sessionId = await resolveSession(
    db,
    message,
    { anonKey, userKey },
    prepared,
    project,
    state,
  );

  // identify() on its own writes no event row: it describes a person, not something
  // that happened.
  if (message.type === 'identify') {
    if (userKey !== null) markMonthlyActive(state, userKey, prepared.occurredAt);
    return ok();
  }

  // --- Step 7: map the event name through the dictionary -----------------------
  const rawName =
    message.type === 'track'
      ? message.event
      : pageEventName(message.type === 'page' ? message.name : undefined);

  // Billing events travel through this same API until the Stripe connector exists
  // (brief section 5), so they are tagged `billing` by name rather than by path.
  const effectiveSource: Source =
    CATALOG_EVENTS_BY_NAME.get(rawName)?.arrival === 'billing' ? 'billing' : project.source;

  const name = await resolveNameId(db, state.names, rawName, effectiveSource, prepared.occurredAt);
  // Counted per occurrence, not per distinct name: resolveNameId is cached.
  countName(state.nameCounts, name.id);

  // --- The page path -----------------------------------------------------------
  const resolvedPath = await resolvePath(db, message, state, prepared.occurredAt);

  const props =
    message.type === 'track' || message.type === 'page' ? (message.properties ?? null) : null;

  /*
   * The session's running totals (brief §4).
   *
   * Counted from what ARRIVED, before the daily cap below, for the same reason the
   * daily counters are: a session that went over the cap still had those page views,
   * and a session whose last event was capped still ended when it ended.
   */
  if (sessionId !== null) {
    addToSession(state.sessionTotals, sessionId, prepared.occurredAt, {
      pageView: rawName === 'Page Viewed',
      activeSeconds:
        rawName === 'Page Left' && typeof props?.['activeSeconds'] === 'number'
          ? props['activeSeconds']
          : 0,
    });
  }

  // --- The daily cap (brief section 4) -----------------------------------------
  if (userKey !== null) {
    const day = prepared.occurredAt.toISOString().slice(0, 10);
    const key = `${day}:${userKey}:${name.id}`;
    let counter = state.arrivedToday.get(key);
    if (counter === undefined) {
      // One query per distinct (day, person, event name) in the batch, not per event.
      const existing = await readDailyCounts(db, [{ day, userKey, nameId: name.id }]);
      counter = { base: existing.get(key) ?? 0, batch: 0 };
      state.arrivedToday.set(key, counter);
    }
    counter.batch += 1;
    const count = counter.base + counter.batch;

    if (count > project.dailyRowsPerUserPerEvent) {
      return filtered(
        'daily_cap_reached',
        `More than ${project.dailyRowsPerUserPerEvent} of these in one day from one person, so we counted it instead of storing it.`,
      );
    }
  }

  // --- Queue the row, and the step state that goes with it ---------------------
  const steps: StepUpdate[] = [];
  if (userKey !== null) {
    if (state.funnel === null) state.funnel = await loadFunnel(db);
    const stepLabel = typeof props?.['step'] === 'string' ? props['step'] : null;
    const activeSeconds = typeof props?.['activeSeconds'] === 'number' ? props['activeSeconds'] : 0;

    for (const match of matchSteps(
      state.funnel ?? EMPTY_FUNNEL,
      name.canonical,
      stepLabel,
      resolvedPath.path,
    )) {
      steps.push({
        userKey,
        stepId: match.stepId,
        kind: match.kind,
        at: prepared.occurredAt,
        activeSeconds,
        sessionId,
      });
    }

    markMonthlyActive(state, userKey, prepared.occurredAt);
    // --- Step 9: queue the heavy work rather than computing it inline ----------
    state.followUps.push({ job: 'recompute-intent', userKey });
  }

  state.pending.push({
    index,
    messageId: prepared.messageId,
    isPageLeft: rawName === 'Page Left',
    steps,
    write: {
      messageHash: prepared.messageHash,
      nameId: name.id,
      userKey,
      anonKey,
      sessionId,
      occurredAt: prepared.occurredAt,
      receivedAt,
      pathId: resolvedPath.pathId,
      props: props && Object.keys(props).length > 0 ? props : null,
      source: effectiveSource,
      late: prepared.late,
    },
  });

  return null;
}

/**
 * Phase two: write the whole batch. Returns one result per queued message, saying
 * which landed and which were duplicates.
 */
export async function flushBatch(
  db: ScopedDb,
  state: PipelineState,
  project: ProjectContext,
): Promise<{ index: number; result: MessageResult }[]> {
  await writeCounters(db, state, project);
  if (state.pending.length === 0) return [];

  /*
   * Within-batch duplicates are settled BEFORE the insert.
   *
   * `ON CONFLICT DO NOTHING` inserts the first of two identical keys in a statement
   * and skips the second without saying so, so RETURNING lists the hash once while
   * both pending entries match it — and both would be reported 'ok' for a single
   * stored row. A client retrying inside one batch would never learn its retry had
   * been collapsed. The simulator's `duplicates` fault is what caught this.
   */
  const firstOccurrence = new Map<string, number>();
  const withinBatchDuplicates = new Set<number>();
  for (const [index, entry] of state.pending.entries()) {
    const seen = firstOccurrence.get(entry.write.messageHash);
    if (seen === undefined) firstOccurrence.set(entry.write.messageHash, index);
    else withinBatchDuplicates.add(index);
  }

  const unique = state.pending.filter((_, index) => !withinBatchDuplicates.has(index));

  const inserted = await writeEvents(
    db,
    unique.map((p) => p.write),
  );

  // Page Left reports running totals, so a second message for the same page view
  // raises the stored numbers instead of being dropped.
  const pageLeftRepeats = state.pending.filter(
    (p) => p.isPageLeft && !inserted.has(p.write.messageHash),
  );
  const raised = await updatePageLeftTotals(
    db,
    pageLeftRepeats.map((p) => p.write),
  );

  const landed = (p: PendingEvent) =>
    inserted.has(p.write.messageHash) || raised.has(p.write.messageHash);

  // Step state only for events that actually landed, so a duplicate cannot inflate
  // an attempt count.
  await applyStepUpdates(
    db,
    unique.filter(landed).flatMap((p) => p.steps),
  );

  return state.pending.map((p, index) => ({
    index: p.index,
    result:
      !withinBatchDuplicates.has(index) && landed(p)
        ? { messageId: p.messageId, status: 'ok' as const, code: 'ok' as const }
        : { messageId: p.messageId, status: 'duplicate' as const, code: 'duplicate' as const },
  }));
}

/**
 * The tracked-user rows and the daily counters, one statement each.
 *
 * These run whether or not any event landed: a batch that was entirely over the cap
 * still has to record that those events arrived, or the cap would reopen next batch
 * and tracking health would never see the overflow.
 */
async function writeCounters(
  db: ScopedDb,
  state: PipelineState,
  project: ProjectContext,
): Promise<void> {
  await flushNameCounts(db, state.nameCounts);
  await flushSessionTotals(db, state.sessionTotals);

  await recordMonthlyActive(
    db,
    [...state.monthlyActive].map((entry) => {
      const [userKey, month] = entry.split('|');
      return { userKey: Number(userKey), month: month! };
    }),
  );

  const deltas: DailyCountDelta[] = [];
  for (const [key, counter] of state.arrivedToday) {
    if (counter.batch === 0) continue;
    const [day, userKey, nameId] = key.split(':');
    deltas.push({
      day: day!,
      userKey: Number(userKey),
      nameId: Number(nameId),
      arrived: counter.batch,
    });
  }
  await writeDailyCounts(db, deltas, project.dailyRowsPerUserPerEvent);
}

function markMonthlyActive(state: PipelineState, userKey: number, at: Date): void {
  state.monthlyActive.add(`${userKey}|${at.toISOString().slice(0, 7)}-01`);
}

/**
 * What a `page` message is called.
 *
 * Our own browser SDK sends a page LEAVE as `{type: 'page', name: 'Page Left'}` with
 * the running totals attached (brief §6), and this function is what reads the name.
 * Before it existed every page message was stored as `Page Viewed`, so:
 *
 *  - no `Page Left` was ever recorded from the SDK, which made step timing's active
 *    seconds and the pricing attention time unreachable, and left
 *    `updatePageLeftTotals` dead in practice — a repeat page leave was dropped as a
 *    duplicate (its messageId is deterministic) instead of raising the totals;
 *  - and every page view was counted twice, once for the view and once for the leave.
 *
 * Segment's `page` call uses `name` for the PAGE's name ("Pricing"), not an event
 * name, so only a name that is actually in our catalog is treated as an event. A
 * Segment page named "Pricing" stays a `Page Viewed` with its name in the properties,
 * which is what a Segment user expects (settled decision 11).
 */
function pageEventName(name: string | undefined): string {
  if (name !== undefined && isCanonicalEventName(name)) return name;
  return 'Page Viewed';
}

function isInternal(email: string, project: ProjectContext): boolean {
  const lower = email.toLowerCase();
  if (project.internalEmails.some((e) => e.toLowerCase() === lower)) return true;
  const domain = emailDomain(lower);
  return domain !== null && project.internalDomains.some((d) => d.toLowerCase() === domain);
}

async function resolveSession(
  db: ScopedDb,
  message: MessageInput,
  keys: { anonKey: number | null; userKey: number | null },
  prepared: PreparedMessage,
  project: ProjectContext,
  state: PipelineState,
): Promise<number | null> {
  const clientSessionId = message.context?.sessionId;

  if (clientSessionId) {
    const cached = state.sessions.get(clientSessionId);
    if (cached !== undefined) return cached;
    const id = await ensureSession(db, {
      clientSessionId,
      anonKey: keys.anonKey,
      userKey: keys.userKey,
      startedAt: prepared.occurredAt,
      context: message.context,
      request: { country: project.country, userAgent: project.userAgent },
    });
    state.sessions.set(clientSessionId, id);
    return id;
  }

  // A server event has no session of its own, so it borrows the user's latest
  // browser session. The founder's server never becomes the user's device.
  if (keys.userKey !== null) {
    const key = `user:${keys.userKey}`;
    const cached = state.sessions.get(key);
    if (cached !== undefined) return cached;
    const id = await latestBrowserSession(db, keys.userKey);
    if (id !== null) state.sessions.set(key, id);
    return id;
  }
  return null;
}

interface ResolvedPath {
  path: string | null;
  pathId: number | null;
}

async function resolvePath(
  db: ScopedDb,
  message: MessageInput,
  state: PipelineState,
  at: Date,
): Promise<ResolvedPath> {
  const page = message.context?.page;
  const raw =
    (message.type === 'page' ? (message.properties?.['path'] as string | undefined) : undefined) ??
    page?.path ??
    page?.url;
  if (typeof raw !== 'string' || raw.length === 0) return { path: null, pathId: null };

  const { path } = normalisePath(raw);
  const cached = state.paths.get(path);
  if (cached !== undefined) return { path, pathId: cached };

  const title = typeof page?.title === 'string' ? page.title.slice(0, 512) : null;
  return { path, pathId: await resolvePathId(db, state.paths, path, title, at) };
}

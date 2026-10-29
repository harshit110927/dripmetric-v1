import { createHash, randomBytes } from 'node:crypto';
import { coarseTime, serializePerson } from './serialize.js';
import {
  GUARD_COLUMNS,
  PERSON_COLUMNS,
  toPersonRow,
  type RawGuardRow,
  type RawPersonRow,
} from './person-row.js';
import type { SerializeContext } from './people.js';
import type { ScopedDb } from './scope.js';

/**
 * The in-app feed, the delivery log and the report bookkeeping (brief §9).
 *
 * "Instant masked alerts go to Slack or Discord … and always to the in-app feed,
 * which has an unread badge that updates live."
 *
 * Always is the word that shapes this file. The feed is the record of what happened;
 * a channel is a convenience on top of it. So an alert is written here whatever
 * becomes of the channel post — over the daily cap, inside quiet hours, no app
 * connected, the webhook returning 500 — and the delivery log records which of those
 * it was.
 */

// --- What is waiting to be told -------------------------------------------

/** A leak with no alert yet, plus the facts the policy and the payload need. */
export interface AlertSubject {
  leakInstanceId: string;
  leakType: string;
  subjectKind: 'user' | 'account' | 'step';
  subjectKey: number;
  firedAt: Date;
  says: string;
  details: Record<string, unknown>;
  episode: number;

  /** The three guards, as they are NOW rather than when the leak was recorded. */
  guards: { paidAt: Date | null; deletedAt: Date | null; optedOut: boolean };
  /**
   * Who it is about, already masked or already named: the gate ran in
   * `serializePerson` before this value existed. Null for a step.
   */
  who: string | null;
  /** True when `who` is a tag rather than a person. */
  masked: boolean;
  intentScore: number | null;
  plan: string | null;
  /** "today" / "this week": coarse, so a masked alert carries no minute. */
  when: string;
}

/**
 * The leaks with no alert row yet.
 *
 * `LEFT JOIN alerts … WHERE a.id IS NULL` rather than a flag on the leak: the unique
 * index on `(project_id, leak_instance_id)` is what guarantees one alert per leak, so
 * the query only has to avoid the obvious repeat work and the index catches a race.
 *
 * Internal and deleted people are excluded in SQL, because a leak about the founder's
 * own team is not a leak. The paid and opted-out guards are NOT filtered here — they
 * come back as facts so the policy can decide, and so the delivery log can say "they
 * paid since this was found" rather than silently skipping it.
 */
export async function alertSubjects(
  db: ScopedDb,
  context: SerializeContext,
  options: { limit?: number } = {},
): Promise<AlertSubject[]> {
  const rows = await db.query<
    RawPersonRow &
      RawGuardRow & {
        leak_instance_id: string;
        leak_type: string;
        subject_kind: 'user' | 'account' | 'step';
        subject_key: number;
        fired_at: Date;
        says: string;
        details: Record<string, unknown>;
        episode: number;
        peak_score: number | null;
        step_label: string | null;
      }
  >(
    `SELECT l.id AS leak_instance_id, l.leak_type, l.subject_kind, l.subject_key,
            l.fired_at, l.says, l.details, l.episode,
            ${PERSON_COLUMNS}, ${GUARD_COLUMNS},
            s.peak_score,
            f.label AS step_label
       FROM leak_instances l
       LEFT JOIN alerts a
              ON a.project_id = l.project_id AND a.leak_instance_id = l.id
       LEFT JOIN end_users u
              ON l.subject_kind = 'user'
             AND u.project_id = l.project_id AND u.user_key = l.subject_key
       LEFT JOIN intent_state s
              ON s.project_id = l.project_id AND s.user_key = l.subject_key
       LEFT JOIN funnel_steps f
              ON l.subject_kind = 'step'
             AND f.project_id = l.project_id AND f.id = l.subject_key
      WHERE l.project_id = $1
        AND l.state = 'open'
        AND a.id IS NULL
        -- A leak about the founder's own team, or someone since deleted, is not news.
        AND (l.subject_kind <> 'user' OR (u.user_key IS NOT NULL AND NOT u.internal))
      ORDER BY l.fired_at
      LIMIT $2`,
    [db.projectId, options.limit ?? 200],
  );

  return rows.map((row) => {
    const isUser = row.subject_kind === 'user' && row.user_key !== null;
    const person = isUser ? serializePerson(toPersonRow(row), context) : null;

    return {
      leakInstanceId: row.leak_instance_id,
      leakType: row.leak_type,
      subjectKind: row.subject_kind,
      subjectKey: row.subject_key,
      firedAt: row.fired_at,
      says: row.says,
      details: row.details,
      episode: row.episode,
      guards: {
        paidAt: row.paid_at,
        deletedAt: row.deleted_at,
        optedOut: row.opted_out,
      },
      who:
        person === null
          ? row.step_label === null
            ? null
            : `Step: ${row.step_label}`
          : person.masked
            ? person.tag
            : (person.email ?? person.name ?? person.userId),
      // A step-collapse alert is unmasked because it is about a step (brief §8.3).
      masked: person === null ? false : person.masked,
      intentScore: row.peak_score,
      plan: planOf(row.traits),
      when: coarseTime(row.fired_at, context.now),
    };
  });
}

/**
 * The founder's own `plan` trait, when they send one.
 *
 * A trait and not a column, so it is whatever string the founder's identify() call
 * puts there. Shown as-is: renaming someone's own plan label would make the alert
 * disagree with their database.
 */
function planOf(traits: Record<string, unknown>): string | null {
  const plan = traits['plan'];
  return typeof plan === 'string' && plan.length > 0 ? plan : null;
}

// --- Writing the alert and its deliveries ----------------------------------

export interface RecordAlertInput {
  leakInstanceId: string;
  leakType: string;
  subjectKind: 'user' | 'account' | 'step';
  subjectKey: number;
  firedAt: Date;
  title: string;
  says: string;
  fields: { label: string; value: string }[];
  masked: boolean;
  route: 'send' | 'hold' | 'feed-only';
  because: string;
  /** Set for 'send' and 'hold': which channel, and when the post is due. */
  delivery: {
    channel: 'slack' | 'discord' | 'email';
    integrationId: string | null;
    dueAt: Date;
  } | null;
}

/**
 * Writes the alert and, when there is one, its delivery.
 *
 * `ON CONFLICT DO NOTHING` on the alert and a null return when it conflicts: the
 * sweep runs every few minutes and will offer the same open leak until it resolves,
 * so the second attempt must be a no-op rather than a second ping. The unique index
 * is the guarantee; this is just the code that expects it.
 */
export async function recordAlert(
  db: ScopedDb,
  input: RecordAlertInput,
): Promise<{ alertId: string } | null> {
  const alert = await db.maybeOne<{ id: string }>(
    `INSERT INTO alerts
       (project_id, leak_instance_id, leak_type, subject_kind, subject_key,
        title, says, fields, masked, fired_at, route, because)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12)
     ON CONFLICT (project_id, leak_instance_id) DO NOTHING
     RETURNING id`,
    [
      db.projectId,
      input.leakInstanceId,
      input.leakType,
      input.subjectKind,
      input.subjectKey,
      input.title,
      input.says,
      JSON.stringify(input.fields),
      input.masked,
      input.firedAt,
      input.route,
      input.because.slice(0, 500),
    ],
  );
  if (!alert) return null;

  if (input.delivery !== null) {
    await db.exec(
      `INSERT INTO alert_deliveries
         (project_id, alert_id, channel, integration_id, state, due_at, because)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (alert_id, channel) DO NOTHING`,
      [
        db.projectId,
        alert.id,
        input.delivery.channel,
        input.delivery.integrationId,
        input.route === 'hold' ? 'held' : 'pending',
        input.delivery.dueAt,
        input.because.slice(0, 500),
      ],
    );
  }

  return { alertId: alert.id };
}

/**
 * How many channel posts have gone out since `since` — the 10-a-day cap's count.
 *
 * Counted by `sent_at`, not by when the alert was created, because the cap is about
 * how often the founder's phone buzzes. An alert held overnight counts against the
 * morning it arrives. `since` is local midnight in the founder's zone, worked out by
 * the engine (CLAUDE.md rule 9: no clock in here either).
 */
export async function channelPostsSince(db: ScopedDb, since: Date): Promise<number> {
  const row = await db.one<{ n: string }>(
    `SELECT count(*) AS n FROM alert_deliveries
      WHERE project_id = $1 AND state = 'sent' AND sent_at >= $2
        AND channel IN ('slack', 'discord')`,
    [db.projectId, since],
  );
  return Number(row.n);
}

/** A delivery that is due: a fresh one, or a held one whose morning has come. */
export interface DueDelivery {
  deliveryId: string;
  alertId: string;
  channel: 'slack' | 'discord' | 'email';
  integrationId: string | null;
  attempts: number;
  title: string;
  says: string;
  fields: { label: string; value: string }[];
  masked: boolean;
  leakType: string;
  firedAt: Date;
}

export async function dueDeliveries(
  db: ScopedDb,
  now: Date,
  options: { limit?: number } = {},
): Promise<DueDelivery[]> {
  const rows = await db.query<{
    delivery_id: string;
    alert_id: string;
    channel: 'slack' | 'discord' | 'email';
    integration_id: string | null;
    attempts: number;
    title: string;
    says: string;
    fields: { label: string; value: string }[];
    masked: boolean;
    leak_type: string;
    fired_at: Date;
  }>(
    `SELECT d.id AS delivery_id, d.alert_id, d.channel, d.integration_id, d.attempts,
            a.title, a.says, a.fields, a.masked, a.leak_type, a.fired_at
       FROM alert_deliveries d
       JOIN alerts a ON a.project_id = d.project_id AND a.id = d.alert_id
      WHERE d.project_id = $1
        AND d.state IN ('pending', 'held')
        AND d.due_at <= $2
      ORDER BY d.due_at
      LIMIT $3`,
    [db.projectId, now, options.limit ?? 50],
  );

  return rows.map((row) => ({
    deliveryId: row.delivery_id,
    alertId: row.alert_id,
    channel: row.channel,
    integrationId: row.integration_id,
    attempts: row.attempts,
    title: row.title,
    says: row.says,
    fields: row.fields,
    masked: row.masked,
    leakType: row.leak_type,
    firedAt: row.fired_at,
  }));
}

/** Brief §9: "Delivery retries with backoff." Doubling, from one minute. */
export const RETRY_BACKOFF_SECONDS = [60, 120, 240, 480, 960] as const;
export const MAX_DELIVERY_ATTEMPTS = RETRY_BACKOFF_SECONDS.length;

export async function markDelivered(db: ScopedDb, deliveryId: string, now: Date): Promise<void> {
  await db.exec(
    `UPDATE alert_deliveries
        SET state = 'sent', sent_at = $3, last_attempt_at = $3,
            attempts = attempts + 1, last_error = NULL
      WHERE project_id = $1 AND id = $2`,
    [db.projectId, deliveryId, now],
  );
}

/**
 * Records a failure and schedules the retry, or gives up.
 *
 * Giving up is a state, not a deletion: `failed` with the channel's own last words,
 * so the settings screen can say the webhook is broken and the founder can see which
 * alerts never arrived. The feed already has all of them.
 */
export async function markDeliveryFailed(
  db: ScopedDb,
  deliveryId: string,
  error: string,
  now: Date,
): Promise<{ willRetry: boolean }> {
  const row = await db.one<{ attempts: number }>(
    `SELECT attempts FROM alert_deliveries WHERE project_id = $1 AND id = $2`,
    [db.projectId, deliveryId],
  );

  const attempts = row.attempts + 1;
  const backoff = RETRY_BACKOFF_SECONDS[attempts - 1];
  const willRetry = backoff !== undefined;

  await db.exec(
    `UPDATE alert_deliveries
        SET state = $3, attempts = $4, last_attempt_at = $5, last_error = $6,
            due_at = CASE WHEN $3 = 'pending' THEN $7 ELSE due_at END
      WHERE project_id = $1 AND id = $2`,
    [
      db.projectId,
      deliveryId,
      willRetry ? 'pending' : 'failed',
      attempts,
      now,
      error.slice(0, 500),
      willRetry ? new Date(now.getTime() + (backoff ?? 0) * 1000) : now,
    ],
  );

  return { willRetry };
}

/** Marks a delivery as deliberately not sent, with the reason. */
export async function skipDelivery(
  db: ScopedDb,
  deliveryId: string,
  because: string,
): Promise<void> {
  await db.exec(
    `UPDATE alert_deliveries SET state = 'skipped', because = $3
      WHERE project_id = $1 AND id = $2`,
    [db.projectId, deliveryId, because.slice(0, 500)],
  );
}

// --- The feed --------------------------------------------------------------

export interface FeedAlert {
  id: string;
  leakType: string;
  title: string;
  says: string;
  fields: { label: string; value: string }[];
  masked: boolean;
  /** Coarse, like everything else about a masked person. */
  when: string;
  read: boolean;
  route: string;
  because: string;
  /** What became of the channel post, for the founder's own confidence. */
  delivery: { channel: string; state: string; attempts: number; lastError: string | null } | null;
}

export async function alertFeed(
  db: ScopedDb,
  now: Date,
  options: { limit?: number } = {},
): Promise<FeedAlert[]> {
  const rows = await db.query<{
    id: string;
    leak_type: string;
    title: string;
    says: string;
    fields: { label: string; value: string }[];
    masked: boolean;
    fired_at: Date;
    read_at: Date | null;
    route: string;
    because: string;
    channel: string | null;
    state: string | null;
    attempts: number | null;
    last_error: string | null;
  }>(
    `SELECT a.id, a.leak_type, a.title, a.says, a.fields, a.masked, a.fired_at,
            a.read_at, a.route, a.because,
            d.channel, d.state, d.attempts, d.last_error
       FROM alerts a
       LEFT JOIN alert_deliveries d
              ON d.project_id = a.project_id AND d.alert_id = a.id
      WHERE a.project_id = $1
      ORDER BY a.created_at DESC
      LIMIT $2`,
    [db.projectId, options.limit ?? 50],
  );

  return rows.map((row) => ({
    id: row.id,
    leakType: row.leak_type,
    title: row.title,
    says: row.says,
    fields: row.fields,
    masked: row.masked,
    when: coarseTime(row.fired_at, now),
    read: row.read_at !== null,
    route: row.route,
    because: row.because,
    delivery:
      row.channel === null
        ? null
        : {
            channel: row.channel,
            state: row.state ?? 'pending',
            attempts: row.attempts ?? 0,
            lastError: row.last_error,
          },
  }));
}

/** The unread badge (brief §9). A count from the partial index, so it stays cheap. */
export async function unreadAlertCount(db: ScopedDb): Promise<number> {
  const row = await db.one<{ n: string }>(
    `SELECT count(*) AS n FROM alerts WHERE project_id = $1 AND read_at IS NULL`,
    [db.projectId],
  );
  return Number(row.n);
}

export async function markFeedRead(db: ScopedDb, now: Date): Promise<number> {
  return db.exec(`UPDATE alerts SET read_at = $2 WHERE project_id = $1 AND read_at IS NULL`, [
    db.projectId,
    now,
  ]);
}

// --- Reports: who gets them, and what has gone out ------------------------

export interface ReportRecipient {
  userId: string;
  email: string;
  weeklyReport: boolean;
  dailyDigest: boolean;
  unsubscribeToken: string | null;
}

/**
 * Who should get a report, creating the subscription row on first sight.
 *
 * The token is generated here and returned once, because only its hash is stored:
 * the plain token exists for the length of one email. That is the same shape as a
 * magic link, and for the same reason — the link lives in an inbox, which is not a
 * place we control.
 */
export async function reportRecipients(db: ScopedDb): Promise<ReportRecipient[]> {
  const members = await db.query<{ user_id: string; email: string }>(
    `SELECT pm.user_id, fu.email
       FROM project_members pm
       JOIN founder_users fu ON fu.id = pm.user_id
      WHERE pm.project_id = $1`,
    [db.projectId],
  );

  const recipients: ReportRecipient[] = [];
  for (const member of members) {
    const token = randomBytes(32).toString('base64url');
    const row = await db.one<{
      weekly_report: boolean;
      daily_digest: boolean;
      unsubscribed_at: Date | null;
      fresh: boolean;
    }>(
      `INSERT INTO report_subscriptions (project_id, user_id, unsubscribe_token_hash)
       VALUES ($1, $2, $3)
       ON CONFLICT (project_id, user_id) DO UPDATE SET project_id = EXCLUDED.project_id
       RETURNING weekly_report, daily_digest, unsubscribed_at,
                 (report_subscriptions.unsubscribe_token_hash = $3) AS fresh`,
      [db.projectId, member.user_id, hashToken(token)],
    );

    recipients.push({
      userId: member.user_id,
      email: member.email,
      weeklyReport: row.weekly_report && row.unsubscribed_at === null,
      dailyDigest: row.daily_digest && row.unsubscribed_at === null,
      // Only a token we just stored can be handed out; an existing row's token is
      // a hash we cannot reverse, so that email gets no new link.
      unsubscribeToken: row.fresh ? token : null,
    });
  }
  return recipients;
}

function hashToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

/**
 * One-click unsubscribe (brief §9).
 *
 * Unscoped on purpose — it is called from a link in an email, where there is no
 * session and no project in hand. The token IS the authorisation, which is why only
 * its hash is stored and why it unsubscribes rather than doing anything destructive.
 */
export async function unsubscribeByToken(db: ScopedDb, token: string, now: Date): Promise<boolean> {
  const row = await db.maybeOne<{ user_id: string }>(
    `UPDATE report_subscriptions
        SET unsubscribed_at = $3, weekly_report = false, daily_digest = false
      WHERE project_id = $1 AND unsubscribe_token_hash = $2
      RETURNING user_id`,
    [db.projectId, hashToken(token), now],
  );
  return row !== null;
}

/**
 * Has this report already gone out for this period?
 *
 * The weekly job is a sweep that runs hourly and asks each project whether it is
 * Monday morning THERE yet, so this is what stops a founder in Auckland getting two.
 * `period_key` is their own local date, and the unique index does the work.
 */
export async function reportAlreadySent(
  db: ScopedDb,
  kind: 'weekly' | 'digest',
  periodKey: string,
): Promise<boolean> {
  const row = await db.maybeOne(
    `SELECT 1 FROM report_runs WHERE project_id = $1 AND kind = $2 AND period_key = $3`,
    [db.projectId, kind, periodKey],
  );
  return row !== null;
}

export async function recordReportRun(
  db: ScopedDb,
  input: {
    kind: 'weekly' | 'digest';
    periodKey: string;
    recipients: number;
    subject: string;
    skippedBecause: string | null;
  },
): Promise<boolean> {
  const row = await db.maybeOne<{ id: string }>(
    `INSERT INTO report_runs (project_id, kind, period_key, recipients, subject, skipped_because)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (project_id, kind, period_key) DO NOTHING
     RETURNING id`,
    [
      db.projectId,
      input.kind,
      input.periodKey,
      input.recipients,
      input.subject.slice(0, 500),
      input.skippedBecause,
    ],
  );
  return row !== null;
}

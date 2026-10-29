import { entitlements, type Entitlements } from './entitlements.js';
import { maskingSecret } from './projects.js';
import { revealState } from './reveals.js';
import { coarseTime, serializePerson, type PersonRow, type SerializedPerson } from './serialize.js';
import type { ScopedDb } from './scope.js';

/**
 * The lists of people the dashboard shows (brief §9).
 *
 * Every function here returns serialized people, never rows. The encrypted columns
 * are read in exactly one query in this file and handed straight to the serializer,
 * so there is no path from a screen to an email that does not pass the gate.
 */

const PERSON_COLUMNS = `
  u.user_key, u.external_id, u.email_ciphertext, u.email_key_id, u.email_type,
  u.name_traits_ciphertext, u.name_traits_key_id, u.traits, u.country,
  u.signed_up_at, u.last_event_at
`;

interface RawPersonRow {
  user_key: number;
  external_id: string;
  email_ciphertext: Buffer | null;
  email_key_id: string | null;
  email_type: PersonRow['emailType'];
  name_traits_ciphertext: Buffer | null;
  name_traits_key_id: string | null;
  traits: Record<string, unknown>;
  country: string | null;
  signed_up_at: Date | null;
  last_event_at: Date | null;
}

function toPersonRow(row: RawPersonRow): PersonRow {
  return {
    userKey: row.user_key,
    externalId: row.external_id,
    emailCiphertext: row.email_ciphertext,
    emailKeyId: row.email_key_id,
    emailType: row.email_type,
    nameTraitsCiphertext: row.name_traits_ciphertext,
    nameTraitsKeyId: row.name_traits_key_id,
    traits: row.traits,
    country: row.country,
    signedUpAt: row.signed_up_at,
    lastEventAt: row.last_event_at,
  };
}

/** Everything the serializer needs, read once per screen rather than per row. */
export interface SerializeContext {
  entitlements: Entitlements;
  projectSecret: Buffer;
  revealed: ReadonlySet<number>;
  now: Date;
}

export async function serializeContext(db: ScopedDb, now: Date): Promise<SerializeContext> {
  /*
   * Sequential, not `Promise.all`.
   *
   * A `ScopedDb` is one client inside one transaction, and pg deprecates
   * `client.query()` while another query is already running on it — it queues them
   * today and will throw in pg 9. Three reads of a handful of rows are not worth a
   * second connection, and a transaction cannot span two anyway.
   */
  const plan = await entitlements(db);
  const secret = await maskingSecret(db);
  const reveals = await revealState(db);
  return { entitlements: plan, projectSecret: secret, revealed: reveals.revealedUserKeys, now };
}

export interface IntentPersonRow {
  person: SerializedPerson;
  score: number;
  band: 'low' | 'warm' | 'high';
  peakScore: number;
  /** The leak they are currently in, if any, in the founder's words. */
  leak: string | null;
  /** Coarse for a masked row; the real time only ever reaches a paid project. */
  lastSeen: string;
  /** How many signals are behind the score. The signals themselves are gated. */
  signalCount: number;
}

/**
 * The Intent module's list (brief §9).
 *
 * "A masked list with tag, band, leak and a coarse time." Note the four things in
 * that sentence: it is a real list a founder can act on, not a count, and none of
 * the four is a person.
 */
export async function intentPeople(
  db: ScopedDb,
  context: SerializeContext,
  options: { minScore?: number; limit?: number } = {},
): Promise<IntentPersonRow[]> {
  const rows = await db.query<
    RawPersonRow & {
      base_points: number;
      peak_score: number;
      state_last_event_at: Date | null;
      leak_says: string | null;
      signal_count: string;
    }
  >(
    `SELECT ${PERSON_COLUMNS},
            s.base_points,
            s.peak_score,
            s.last_event_at AS state_last_event_at,
            (SELECT l.says FROM leak_instances l
              WHERE l.project_id = u.project_id
                AND l.subject_kind = 'user' AND l.subject_key = u.user_key
                AND l.state = 'open'
              ORDER BY l.fired_at DESC LIMIT 1) AS leak_says,
            (
              (s.checkout_started)::int + (s.activated)::int + (s.plan_limit_or_paywall)::int
              + (s.pricing_viewed)::int + (s.pricing_deliberation)::int + (s.invite_sent)::int
              + (s.integration_or_import)::int + (s.core_action_early)::int
              + (s.active_three_of_seven)::int + (s.fast_activation)::int
              + (s.payment_method_before_trial_end)::int + (s.sales_contact_requested)::int
              + (CASE WHEN s.fit::text <> '{}' THEN 1 ELSE 0 END)
            )::text AS signal_count
       FROM intent_state s
       JOIN end_users u ON u.project_id = s.project_id AND u.user_key = s.user_key
      WHERE s.project_id = $1
        AND u.deleted_at IS NULL AND NOT u.internal AND NOT u.opted_out
        AND s.peak_score >= $2
      ORDER BY s.peak_score DESC, s.user_key
      LIMIT $3`,
    [db.projectId, options.minScore ?? 0, options.limit ?? 50],
  );

  return rows.map((row) => {
    // The same decay the engine applies, from the stored base points.
    const quietDays =
      row.state_last_event_at === null
        ? null
        : Math.max(0, (context.now.getTime() - row.state_last_event_at.getTime()) / 86_400_000);
    const score =
      quietDays === null ? 0 : Math.round(row.base_points * Math.pow(2, -quietDays / 7));

    return {
      person: serializePerson(toPersonRow(row), context),
      score,
      band: score >= 60 ? 'high' : score >= 30 ? 'warm' : 'low',
      peakScore: row.peak_score,
      leak: row.leak_says,
      lastSeen: coarseTime(row.state_last_event_at, context.now),
      signalCount: Number(row.signal_count),
    };
  });
}

export interface LeakPersonRow {
  person: SerializedPerson;
  /** What happened, in the founder's words, as stored when the leak fired. */
  says: string;
  /** Coarse: a masked row must not carry a minute (brief §9). */
  when: string;
  details: Record<string, unknown>;
  episode: number;
}

/**
 * The people behind one leak (brief §9's Checkout and "Payers going quiet" modules).
 *
 * The leak's own sentence is shown whether or not the person is revealed — it is
 * about what happened, not about who they are. The time is coarse for a masked row
 * for the reason brief §9 gives: a precise one can be matched against the founder's
 * own logs.
 */
export async function leakPeople(
  db: ScopedDb,
  context: SerializeContext,
  leakType: string,
  options: { limit?: number } = {},
): Promise<LeakPersonRow[]> {
  const rows = await db.query<
    RawPersonRow & {
      says: string;
      fired_at: Date;
      details: Record<string, unknown>;
      episode: number;
    }
  >(
    `SELECT ${PERSON_COLUMNS}, l.says, l.fired_at, l.details, l.episode
       FROM leak_instances l
       JOIN end_users u ON u.project_id = l.project_id AND u.user_key = l.subject_key
      WHERE l.project_id = $1
        AND l.leak_type = $2
        AND l.subject_kind = 'user'
        AND l.state = 'open'
        AND u.deleted_at IS NULL AND NOT u.internal AND NOT u.opted_out
      ORDER BY l.fired_at DESC
      LIMIT $3`,
    [db.projectId, leakType, options.limit ?? 50],
  );

  return rows.map((row) => ({
    person: serializePerson(toPersonRow(row), context),
    says: row.says,
    when: coarseTime(row.fired_at, context.now),
    details: row.details,
    episode: row.episode,
  }));
}

/** One person, for the reveal flow and for a per-person screen later. */
export async function person(
  db: ScopedDb,
  context: SerializeContext,
  userKey: number,
): Promise<SerializedPerson | null> {
  const row = await db.maybeOne<RawPersonRow>(
    `SELECT ${PERSON_COLUMNS} FROM end_users u
      WHERE u.project_id = $1 AND u.user_key = $2 AND u.deleted_at IS NULL`,
    [db.projectId, userKey],
  );
  if (!row) return null;
  return serializePerson(toPersonRow(row), context);
}

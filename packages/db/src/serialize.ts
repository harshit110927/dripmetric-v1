import { can, type Entitlements } from './entitlements.js';
import { decryptText, maskTag } from './crypto.js';

/**
 * The masked and full serializers (brief §9).
 *
 * "Masking is a commercial gate, not a privacy control (the founder owns the data),
 * so it must be airtight on our side. Enforce it on the server through one function,
 * `can(project, feature)`. A free project's API responses never contain an email,
 * name, user id or trait for any person."
 *
 * And: "Enforce this in the data-access layer: serializers choose the masked or full
 * shape from `can()`."
 *
 * So this file is the only place a person becomes a row. Nothing else may read
 * `email_ciphertext`, and no screen may decide for itself what to show — because a
 * gate that each caller applies is a gate each caller can forget.
 */

/** What the database holds about a person. Only this file sees it. */
export interface PersonRow {
  userKey: number;
  externalId: string;
  emailCiphertext: Buffer | null;
  emailKeyId: string | null;
  emailType: 'work' | 'free' | 'education' | 'disposable' | null;
  nameTraitsCiphertext: Buffer | null;
  nameTraitsKeyId: string | null;
  traits: Record<string, unknown>;
  country: string | null;
  signedUpAt: Date | null;
  lastEventAt: Date | null;
}

/**
 * A person as a free project sees them.
 *
 * Every field is either a derived hint or a shape. There is no field here that could
 * be turned back into a person, which is what makes the scan in M9's exit checks
 * something the code can satisfy rather than something a reviewer has to watch.
 */
export interface MaskedPerson {
  masked: true;
  /** "User A7F2C1" — stable per person, not reversible (brief §9). */
  tag: string;
  /** "work address" | "free address" | … | null. A hint, not an address. */
  emailHint: string | null;
  /** A fixed-length bar standing in for the name, e.g. "███████". */
  nameBar: string;
  /** "3 traits", so the founder knows there is something to unlock. */
  traitsHint: string | null;
  country: string | null;
  /** "today" | "yesterday" | "this week" | "this month" | "earlier". */
  lastSeen: string;
  signedUp: string | null;
}

/** A person as a paid project sees them. */
export interface FullPerson {
  masked: false;
  userKey: number;
  /** The founder's own id for them, which is the join key to their database. */
  userId: string;
  email: string | null;
  emailType: PersonRow['emailType'];
  name: string | null;
  company: string | null;
  traits: Record<string, unknown>;
  country: string | null;
  lastEventAt: Date | null;
  signedUpAt: Date | null;
}

export type SerializedPerson = MaskedPerson | FullPerson;

/**
 * A bar of fixed length, so the length of a name cannot be read off the screen.
 *
 * Seven blocks whatever the name, because a bar whose width matched the real name
 * would leak the length of it — and "is this one of my three customers called Jo?" is
 * a question a founder could often answer from that.
 */
export const NAME_BAR = '█'.repeat(7);

const EMAIL_HINTS: Record<NonNullable<PersonRow['emailType']>, string> = {
  work: 'work address',
  free: 'free address',
  education: 'school address',
  disposable: 'throwaway address',
};

/**
 * Coarse times (brief §9).
 *
 * "Times stay coarse ('today', 'yesterday', 'this week') so a masked alert cannot be
 * matched against the founder's logs or Stripe by the minute."
 *
 * That is the actual attack, and it is a good one: a founder with a masked alert and
 * a server log can identify the person from a timestamp alone. So a masked row never
 * carries one.
 */
export function coarseTime(at: Date | null, now: Date): string {
  if (at === null) return 'not yet';
  const days = Math.floor((startOfDay(now) - startOfDay(at)) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return 'this week';
  if (days < 31) return 'this month';
  return 'earlier';
}

function startOfDay(at: Date): number {
  return Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
}

function traitsHint(traits: Record<string, unknown>): string | null {
  const count = Object.keys(traits).length;
  if (count === 0) return null;
  return `${count} ${count === 1 ? 'trait' : 'traits'}`;
}

export function maskPerson(row: PersonRow, projectSecret: Buffer, now: Date): MaskedPerson {
  return {
    masked: true,
    tag: `User ${maskTag(projectSecret, row.externalId)}`,
    emailHint: row.emailType === null ? null : EMAIL_HINTS[row.emailType],
    nameBar: NAME_BAR,
    traitsHint: traitsHint(row.traits),
    country: row.country,
    lastSeen: coarseTime(row.lastEventAt, now),
    signedUp: row.signedUpAt === null ? null : coarseTime(row.signedUpAt, now),
  };
}

export function revealPerson(row: PersonRow): FullPerson {
  const names = decryptNameTraits(row);
  return {
    masked: false,
    userKey: row.userKey,
    userId: row.externalId,
    email:
      row.emailCiphertext === null || row.emailKeyId === null
        ? null
        : decryptText(row.emailCiphertext, row.emailKeyId),
    emailType: row.emailType,
    name: pickName(names),
    company: typeof names['company'] === 'string' ? names['company'] : null,
    traits: row.traits,
    country: row.country,
    lastEventAt: row.lastEventAt,
    signedUpAt: row.signedUpAt,
  };
}

function decryptNameTraits(row: PersonRow): Record<string, unknown> {
  if (row.nameTraitsCiphertext === null || row.nameTraitsKeyId === null) return {};
  try {
    return JSON.parse(decryptText(row.nameTraitsCiphertext, row.nameTraitsKeyId)) as Record<
      string,
      unknown
    >;
  } catch {
    // A row whose key has been rotated away is not a reason to fail a whole screen.
    return {};
  }
}

function pickName(names: Record<string, unknown>): string | null {
  const full = names['name'];
  if (typeof full === 'string' && full.length > 0) return full;
  const first = typeof names['firstName'] === 'string' ? names['firstName'] : '';
  const last = typeof names['lastName'] === 'string' ? names['lastName'] : '';
  const joined = `${first} ${last}`.trim();
  return joined.length > 0 ? joined : null;
}

/**
 * The gate. Every list of people goes through here.
 *
 * `revealed` is for the reveal allowance: a free project may unmask a handful of
 * individual people (brief §2), and those specific ones come back full while the rest
 * stay masked.
 */
export function serializePerson(
  row: PersonRow,
  options: {
    entitlements: Entitlements;
    projectSecret: Buffer;
    now: Date;
    /** User keys this project has spent a reveal on. */
    revealed?: ReadonlySet<number>;
  },
): SerializedPerson {
  if (can(options.entitlements, 'reveal_identity')) return revealPerson(row);
  if (options.revealed?.has(row.userKey) === true) return revealPerson(row);
  return maskPerson(row, options.projectSecret, options.now);
}

/**
 * The signals behind a score (brief §9).
 *
 * "Name, email, company and the signals behind a score appear as fixed-length bars,
 * with hints such as 'work address' or '3 signals'." So a free project is told how
 * many reasons there are, never which — the count is the part that makes the gate
 * feel like a gate rather than a blank.
 */
export function serializeSignals(
  signals: readonly { says: string; points: number }[],
  entitlements: Entitlements,
):
  | { revealed: true; signals: readonly { says: string; points: number }[] }
  | {
      revealed: false;
      hint: string;
      bars: string[];
    } {
  if (can(entitlements, 'why_signals')) return { revealed: true, signals };
  return {
    revealed: false,
    hint: `${signals.length} ${signals.length === 1 ? 'signal' : 'signals'}`,
    bars: signals.map(() => NAME_BAR),
  };
}

import type { PersonRow } from './serialize.js';

/**
 * The encrypted person columns, and the one place they are named.
 *
 * Internal to @dripmetric/db and deliberately not in `index.ts`: outside this package
 * a person is a `SerializedPerson`, never a row. Shared by `people.ts` (the dashboard
 * lists) and `alerts.ts` (the feed), because a second copy of this column list is a
 * second place to forget `email_ciphertext` is encrypted.
 */
export const PERSON_COLUMNS = `
  u.user_key, u.external_id, u.email_ciphertext, u.email_key_id, u.email_type,
  u.name_traits_ciphertext, u.name_traits_key_id, u.traits, u.country,
  u.signed_up_at, u.last_event_at
`;

/** The three guards every per-person alert and leak is checked against (brief §8.3). */
export const GUARD_COLUMNS = `
  u.paid_at, u.deleted_at, u.opted_out, u.internal
`;

export interface RawPersonRow {
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

export interface RawGuardRow {
  paid_at: Date | null;
  deleted_at: Date | null;
  opted_out: boolean;
  internal: boolean;
}

export function toPersonRow(row: RawPersonRow): PersonRow {
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

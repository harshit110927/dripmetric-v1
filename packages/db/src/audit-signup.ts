import { createHash } from 'node:crypto';
import { classifyEmailDomain } from './signup-guards.js';
import type { UnscopedDb } from './scope.js';

/**
 * Guards on the email-only instant project (brief §9's free audit).
 *
 * "Email in, project and keys out… limit creation per IP and filter disposable
 * emails."
 *
 * Both guards exist because the flow has no password and no payment: the only thing
 * between it and someone minting ten thousand projects is this file.
 */

/** How many projects one IP may create in a day. Generous for a shared office. */
export const SIGNUPS_PER_IP_PER_DAY = 5;

/**
 * The IP is HASHED before it is stored.
 *
 * It is only ever used to count, never to identify, so a hash does the whole job —
 * and an IP address is personal data in the EU, which makes storing the plain value a
 * liability for no gain. Salted with the project's own... nothing, deliberately: the
 * count has to work across projects that do not exist yet.
 */
function hashIp(ip: string): Buffer {
  return createHash('sha256').update(ip, 'utf8').digest();
}

export interface SignupGuardResult {
  allowed: boolean;
  /** What to tell the person, in their words. Never mentions the limit's size. */
  because: string;
  /** For the log and for M13's monitoring. */
  reason: 'ok' | 'disposable-email' | 'ip-limit' | 'bad-email';
}

/**
 * Can this email, from this IP, make a project right now?
 *
 * The email check runs first because it is free and because a disposable address is
 * the clearer refusal: telling someone "that address will not work" is actionable,
 * whereas "too many projects from your network" is not their fault.
 */
export async function checkSignupAllowed(
  db: UnscopedDb,
  email: string,
  ip: string | null,
  now: Date,
): Promise<SignupGuardResult> {
  const classified = classifyEmailDomain(email);

  if (classified === 'invalid') {
    return {
      allowed: false,
      reason: 'bad-email',
      because: 'That does not look like an email address.',
    };
  }

  if (classified === 'disposable') {
    return {
      allowed: false,
      reason: 'disposable-email',
      because:
        'That looks like a throwaway address. Use the email you actually read — the ' +
        'dashboard link and your weekly report go there.',
    };
  }

  /*
   * No IP is not a refusal.
   *
   * Behind some proxies there is no forwarded address to read, and refusing everyone
   * in that situation would make the product unusable for them. The email guard still
   * applies, and M13's rate limiting is the backstop.
   */
  if (ip === null) return { allowed: true, reason: 'ok', because: '' };

  const since = new Date(now.getTime() - 86_400_000);
  const row = await db.one<{ n: string }>(
    `SELECT count(*) AS n FROM signup_attempts
      WHERE ip_hash = $1 AND created_at >= $2 AND created_project`,
    [hashIp(ip), since],
  );

  if (Number(row.n) >= SIGNUPS_PER_IP_PER_DAY) {
    return {
      allowed: false,
      reason: 'ip-limit',
      because:
        'That is a lot of projects from one network today. Email hello@dripmetric.com ' +
        'and we will sort it out.',
    };
  }

  return { allowed: true, reason: 'ok', because: '' };
}

/** Records the attempt, allowed or not, so the count means something. */
export async function recordSignupAttempt(
  db: UnscopedDb,
  input: { email: string; ip: string | null; createdProject: boolean; reason: string },
  now: Date,
): Promise<void> {
  await db.exec(
    `INSERT INTO signup_attempts (ip_hash, email_domain, created_project, reason, created_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      input.ip === null ? null : hashIp(input.ip),
      /*
       * The DOMAIN, not the address.
       *
       * Enough to see an abuse pattern — a hundred attempts from one domain — and not
       * a list of everyone who ever tried the product and did not finish.
       */
      input.email.includes('@') ? input.email.split('@').pop()?.toLowerCase() : null,
      input.createdProject,
      input.reason,
      now,
    ],
  );
}

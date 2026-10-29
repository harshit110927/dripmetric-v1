/**
 * Classifying an email domain, for the signup guard (brief §9).
 *
 * In `packages/db` rather than `packages/ingest` because the signup flow needs it and
 * the web app may not import ingest's internals. The disposable list is deliberately
 * SHORT: it covers the providers that exist only to be thrown away, and nothing that
 * a real person might plausibly use as their only address. A false positive here
 * means telling a paying customer their email is fake.
 */

export type EmailClass = 'work' | 'free' | 'disposable' | 'invalid';

/** Free-but-real providers. Allowed: plenty of founders use them.  */
const FREE_PROVIDERS = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'yahoo.com',
  'yahoo.co.uk',
  'icloud.com',
  'me.com',
  'proton.me',
  'protonmail.com',
  'gmx.com',
  'yandex.com',
  'zoho.com',
  'aol.com',
]);

/**
 * Throwaway providers. Refused.
 *
 * Every one of these advertises itself as temporary — an address here cannot receive
 * a weekly report next month, which is the whole product.
 */
const DISPOSABLE_PROVIDERS = new Set([
  'mailinator.com',
  'guerrillamail.com',
  'guerrillamail.info',
  '10minutemail.com',
  'tempmail.com',
  'temp-mail.org',
  'throwawaymail.com',
  'yopmail.com',
  'trashmail.com',
  'getnada.com',
  'dispostable.com',
  'maildrop.cc',
  'sharklasers.com',
  'fakeinbox.com',
  'mintemail.com',
  'mohmal.com',
  'tempr.email',
  'spamgourmet.com',
  'discard.email',
  'mailnesia.com',
]);

/**
 * A deliberately strict shape check.
 *
 * Not RFC 5322 — that grammar admits addresses no provider accepts. This asks for one
 * `@`, a dot in the domain and no whitespace, which rejects typos without rejecting
 * anything real.
 */
const SHAPE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

export function classifyEmailDomain(email: string): EmailClass {
  const trimmed = email.trim().toLowerCase();
  if (!SHAPE.test(trimmed)) return 'invalid';

  const domain = trimmed.split('@').pop() ?? '';
  if (DISPOSABLE_PROVIDERS.has(domain)) return 'disposable';
  if (FREE_PROVIDERS.has(domain)) return 'free';
  return 'work';
}

export function isDisposableDomain(domain: string): boolean {
  return DISPOSABLE_PROVIDERS.has(domain.trim().toLowerCase());
}

/**
 * The scrubber (brief §7, "Never send end-user personal data").
 *
 * "Scrub emails, phone numbers, ids, tokens, URLs with query strings and anything
 * that looks like a name before the prompt is built."
 *
 * This is the single most important function in the mapping layer, because it is the
 * only thing standing between a founder's end users and a third-party model. It is
 * written to be paranoid and dull: it REMOVES rather than transforms, it errs toward
 * dropping a legitimate value, and it has no configuration to get wrong.
 *
 * It is a pure function with no I/O, so the test that proves it can assert on exactly
 * what a prompt would contain (brief §11: "the scrub test shows no email, phone, id
 * or token reaches the model prompt").
 */

/** What a scrubbed value becomes. Not a mask of the original: a type name. */
export const REDACTED = '[redacted]';

/**
 * Patterns that mean "this is about a person, not about a product".
 *
 * A value is dropped if ANY of them match, so order does not change WHETHER it is
 * dropped — but it does decide the reason reported, and a specific reason is what
 * makes a log worth reading. So they run most-specific first, with the loose
 * `phone` shape last: it otherwise claims card numbers and IP addresses, both of
 * which it technically matches.
 */
const PERSONAL_PATTERNS: readonly { name: string; pattern: RegExp }[] = [
  { name: 'email', pattern: /[^\s@]+@[^\s@]+\.[^\s@]{2,}/ },
  // JWTs are three dot-separated base64 segments. Before the generic token rule.
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/ },
  { name: 'uuid', pattern: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i },
  // A URL with a query string: the path may be fine, the query never is.
  { name: 'url-with-query', pattern: /https?:\/\/\S*\?\S/ },
  // Any URL at all. A bare URL tells the model nothing a path would not.
  { name: 'url', pattern: /https?:\/\//i },
  // An IP address, before `phone` would claim the digits.
  { name: 'ip', pattern: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/ },
  // A credit-card-length digit run, also before `phone`.
  { name: 'card', pattern: /\b\d{13,19}\b/ },
  /*
   * Stripe-style and other prefixed ids: cus_…, sub_…, pi_…, user_…, acct_…
   *
   * The optional second segment matters: `sk_live_…` and `pk_test_…` are the
   * shapes most worth catching, and a single-underscore pattern misses them —
   * `\b` fails before `live_…` because the preceding `_` is a word character, so
   * only the generic token rule caught them.
   */
  { name: 'prefixed-id', pattern: /\b[a-z]{2,8}(?:_[a-z]{2,8})?_[A-Za-z0-9]{8,}\b/ },
  { name: 'hex', pattern: /\b[0-9a-f]{16,}\b/i },
  // A long base64-ish run: a token, a hash, a session id, a key.
  { name: 'token', pattern: /\b[A-Za-z0-9_-]{24,}\b/ },
  // Loosest, so it runs last: international and local phone shapes, long enough
  // not to catch a price.
  { name: 'phone', pattern: /(?:\+\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?){2,4}\d{2,4}/ },
];

/**
 * Property keys whose VALUE is personal by definition, whatever it looks like.
 *
 * A key-based rule catches what a pattern cannot: `"name": "Pat"` is four letters
 * and matches nothing, but it is still somebody's name.
 */
const PERSONAL_KEYS: readonly RegExp[] = [
  /(^|_|\.)e?mail(_|\.|$)/i,
  /(^|_|\.)(first|last|full|display|user|customer|contact|account|company|org|employer)?_?name(_|\.|$)/i,
  /(^|_|\.)(phone|mobile|tel|telephone)(_|\.|$)/i,
  /(^|_|\.)(address|street|city|postcode|zip|postal)(_|\.|$)/i,
  /(^|_|\.)(password|secret|token|key|auth|bearer|session|cookie|signature|hmac)(_|\.|$)/i,
  /(^|_|\.)(ssn|nino|tax|vat|passport|licence|license)(_|\.|$)/i,
  /(^|_|\.)(dob|birth|birthday|age)(_|\.|$)/i,
  /(^|_|\.)(ip|useragent|user_agent)(_|\.|$)/i,
  /(^|_|\.)(lat|lng|lon|latitude|longitude|geo|coords?)(_|\.|$)/i,
  /(^|_|\.)(id|uuid|guid)(_|\.|$)/i,
  /(^|_|\.)(stripe|customer|subscription|invoice|charge|payment)_?id(_|\.|$)/i,
];

/**
 * A sample value is only worth showing the model when it is SHORT and the property
 * has FEW distinct values — a plan name, a step label, a method. Anything longer is
 * free text or an identifier.
 */
export const MAX_SAMPLE_LENGTH = 24;
export const MAX_DISTINCT_FOR_SAMPLE = 12;

export interface ScrubResult {
  /** The value to use, or null when it must not be shown at all. */
  value: string | null;
  /** Why it was dropped. For the test, and for an operator reading a log. */
  reason: string | null;
}

/** True when a property's NAME means its value is personal, whatever it contains. */
export function isPersonalKey(key: string): boolean {
  return PERSONAL_KEYS.some((pattern) => pattern.test(key));
}

/** True when a VALUE looks personal, whatever its key is called. */
export function looksPersonal(value: string): string | null {
  for (const { name, pattern } of PERSONAL_PATTERNS) {
    if (pattern.test(value)) return name;
  }
  return null;
}

/**
 * Decides whether one sample value may be shown to the model.
 *
 * Every rule here is a reason to say no. There is deliberately no path that
 * transforms a value into a "safe" version: a partially redacted email is still an
 * email leaving the building.
 */
export function scrubSample(key: string, value: unknown, distinctValues: number): ScrubResult {
  if (isPersonalKey(key)) return { value: null, reason: `key "${key}" is personal` };

  if (value === null || value === undefined) return { value: null, reason: 'empty' };

  // Booleans and small numbers carry no identity and are genuinely useful: they tell
  // the model that `paywall` is a flag and `count` is a quantity.
  if (typeof value === 'boolean') return { value: String(value), reason: null };
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return { value: null, reason: 'not a finite number' };
    // A long number is an id or a timestamp, not a quantity worth showing.
    if (Math.abs(value) >= 1e9) return { value: null, reason: 'number is id-sized' };
    return { value: String(value), reason: null };
  }

  if (typeof value !== 'string') return { value: null, reason: `type ${typeof value}` };

  const trimmed = value.trim();
  if (trimmed.length === 0) return { value: null, reason: 'empty' };

  /*
   * The personal patterns run BEFORE the length and cardinality limits.
   *
   * The outcome is the same either way — the value is dropped — but the REASON is
   * what an operator reads, and "longer than 24 characters" is a much worse answer
   * than "looks like email". It also keeps these rules load-bearing: if the length
   * limit were ever raised, a long token would still be caught for what it is.
   */
  const personal = looksPersonal(trimmed);
  if (personal) return { value: null, reason: `looks like ${personal}` };

  if (trimmed.length > MAX_SAMPLE_LENGTH) {
    return { value: null, reason: `longer than ${MAX_SAMPLE_LENGTH} characters` };
  }
  if (distinctValues > MAX_DISTINCT_FOR_SAMPLE) {
    return { value: null, reason: `${distinctValues} distinct values: not an enum` };
  }

  return { value: trimmed, reason: null };
}

/**
 * Scrubs a raw EVENT NAME.
 *
 * Founders name events after things, not people, so this is usually a no-op — but
 * `track('Invoice sent to sam@acme.com')` happens, and the name is the one field
 * that always reaches the prompt.
 */
export function scrubEventName(name: string): string {
  let out = name.slice(0, 120);
  for (const { pattern } of PERSONAL_PATTERNS) {
    out = out.replace(
      new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g'),
      REDACTED,
    );
  }
  return out;
}

/** The type of a value, for the shape-only part of the prompt. */
export function valueTypeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

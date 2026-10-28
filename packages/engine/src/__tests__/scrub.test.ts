import { describe, expect, it } from 'vitest';
import {
  isPersonalKey,
  looksPersonal,
  scrubEventName,
  scrubSample,
  valueTypeOf,
} from '../mapping/scrub.js';

/**
 * The scrubber (brief §7 and §11: "the scrub test shows no email, phone, id or token
 * reaches the model prompt").
 *
 * This is the only thing between a founder's end users and a third-party model, so
 * these tests are adversarial on purpose. Every case below is something a real
 * product actually puts in an event property.
 */
describe('values that must never reach the model', () => {
  const mustDrop = (key: string, value: unknown, distinct = 3) => {
    const result = scrubSample(key, value, distinct);
    expect(result.value, `"${String(value)}" under key "${key}" was NOT dropped`).toBeNull();
    expect(result.reason).toBeTruthy();
    return result.reason!;
  };

  it('drops an email, however it is keyed', () => {
    mustDrop('email', 'sam@acme.com');
    mustDrop('contact', 'sam@acme.com');
    // The key is innocent and the value is not: the pattern has to catch it.
    expect(mustDrop('plan', 'sam@acme.com')).toContain('email');
  });

  it('drops a phone number', () => {
    mustDrop('phone', '+44 7700 900123');
    expect(mustDrop('plan', '+1 (555) 010-9999')).toContain('phone');
  });

  it('drops anything that identifies a person or a record', () => {
    expect(mustDrop('plan', '550e8400-e29b-41d4-a716-446655440000')).toContain('uuid');
    expect(mustDrop('plan', 'cus_Nf8xKd92LaQqZz')).toContain('prefixed-id');
    expect(mustDrop('plan', 'a3f91c2b8e7d4061a3f9')).toContain('hex');
  });

  it('drops a token, a key and a JWT', () => {
    /*
     * Two-segment prefixes are the shapes most worth catching: real API keys look
     * like `sk_live_…` and `pk_test_…`, and a single-underscore pattern misses them.
     *
     * The fixtures below deliberately do NOT use a real vendor's prefix with a
     * real-length body. A literal of exactly that shape is indistinguishable from a
     * leaked key to a secret scanner and to the next person reading this file — and
     * GitHub's push protection blocked this very line when it did. These exercise
     * the identical regex branch and could not be mistaken for anything live.
     */
    expect(mustDrop('plan', 'key_live_EXAMPLEONLYNOTREAL')).toContain('prefixed-id');
    expect(mustDrop('plan', 'tok_test_EXAMPLEONLYNOTREAL')).toContain('prefixed-id');
    expect(mustDrop('plan', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc')).toContain(
      'jwt',
    );
  });

  it('drops a URL, with or without a query string', () => {
    expect(mustDrop('plan', 'https://acme.com/r?token=abc')).toContain('url-with-query');
    expect(mustDrop('plan', 'https://acme.com')).toContain('url');
  });

  it('drops an IP address and a card number', () => {
    expect(mustDrop('plan', '203.0.113.9')).toContain('ip');
    expect(mustDrop('plan', '4242424242424242')).toContain('card');
  });

  it('drops a value under a personal KEY even when it looks harmless', () => {
    // "Pat" matches no pattern at all. The key is the only clue.
    expect(mustDrop('name', 'Pat')).toContain('personal');
    expect(mustDrop('first_name', 'Pat')).toContain('personal');
    expect(mustDrop('company_name', 'Acme')).toContain('personal');
    expect(mustDrop('user_id', 'u7')).toContain('personal');
    expect(mustDrop('session_token', 'x')).toContain('personal');
    expect(mustDrop('dob', '1990')).toContain('personal');
    expect(mustDrop('latitude', '51.5')).toContain('personal');
  });

  it('drops free text, which is where people put anything at all', () => {
    expect(
      mustDrop('feedback', 'I could not work out how to connect my bank account'),
    ).toBeTruthy();
  });

  it('drops a value from a high-cardinality property, which is an id by another name', () => {
    // 4,000 distinct values is not an enum, whatever each one looks like.
    expect(mustDrop('workspace', 'acme', 4000)).toContain('distinct');
  });

  it('drops an id-sized number', () => {
    expect(mustDrop('plan', 1_699_999_999_999)).toContain('id-sized');
  });
});

describe('values that are safe and genuinely useful', () => {
  const kept = (key: string, value: unknown, distinct = 3) => {
    const result = scrubSample(key, value, distinct);
    expect(
      result.reason,
      `"${String(value)}" under "${key}" was dropped: ${result.reason}`,
    ).toBeNull();
    return result.value;
  };

  it('keeps short enum-like strings, which is what makes a mapping guessable', () => {
    // These are the whole point: they tell the model that `plan` is a tier and
    // `step` is an onboarding stage.
    expect(kept('plan', 'pro')).toBe('pro');
    expect(kept('interval', 'month')).toBe('month');
    expect(kept('method', 'google')).toBe('google');
    expect(kept('step', 'connect-bank')).toBe('connect-bank');
    expect(kept('limit', 'invoices')).toBe('invoices');
  });

  it('keeps flags and small quantities', () => {
    expect(kept('paywall', true)).toBe('true');
    expect(kept('count', 3)).toBe('3');
    expect(kept('amount', 2900)).toBe('2900');
  });

  it('trims whitespace rather than treating it as content', () => {
    expect(kept('plan', '  pro  ')).toBe('pro');
  });
});

describe('event names', () => {
  it('leaves an ordinary name alone', () => {
    expect(scrubEventName('Invoice Sent')).toBe('Invoice Sent');
    expect(scrubEventName('workspace_setup_done')).toBe('workspace_setup_done');
  });

  it('redacts a name a founder built from user data', () => {
    // `track('Invoice sent to ' + user.email)` is a real mistake, and the name is
    // the one field that always reaches the prompt.
    const scrubbed = scrubEventName('Invoice sent to sam@acme.com');
    expect(scrubbed).not.toContain('sam@acme.com');
    expect(scrubbed).toContain('[redacted]');
  });

  it('caps a runaway name', () => {
    expect(scrubEventName('x'.repeat(500)).length).toBeLessThanOrEqual(120);
  });
});

describe('the helpers the prompt builder uses', () => {
  it('names a value’s type for the shape-only part of the prompt', () => {
    expect(valueTypeOf('a')).toBe('string');
    expect(valueTypeOf(1)).toBe('number');
    expect(valueTypeOf(true)).toBe('boolean');
    expect(valueTypeOf(null)).toBe('null');
    expect(valueTypeOf([1])).toBe('array');
    expect(valueTypeOf({})).toBe('object');
  });

  it('recognises a personal key by shape, not by an exact list', () => {
    expect(isPersonalKey('email')).toBe(true);
    expect(isPersonalKey('billing_email')).toBe(true);
    expect(isPersonalKey('userName')).toBe(true);
    expect(isPersonalKey('plan')).toBe(false);
    expect(isPersonalKey('step')).toBe(false);
  });

  it('reports WHICH pattern matched, so a log says why', () => {
    expect(looksPersonal('sam@acme.com')).toBe('email');
    expect(looksPersonal('pro')).toBeNull();
  });
});

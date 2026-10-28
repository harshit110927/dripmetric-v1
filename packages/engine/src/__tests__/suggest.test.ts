import { describe, expect, it, vi } from 'vitest';
import { buildPrompt, estimateTokens, MAX_NAMES_IN_PROMPT } from '../mapping/prompt.js';
import type { EventNameFact, PromptInput } from '../mapping/prompt.js';
import { parseSuggestions, suggestMappings, type Ask } from '../mapping/suggest.js';

/** The dozen meanings a founder may map onto (brief §7). */
const MEANINGS = [
  'Signed Up',
  'Onboarding Step Completed',
  'Activated',
  'Core Action',
  'Pricing Viewed',
  'Plan Limit Reached',
  'Checkout Started',
  'Subscription Started',
  'Subscription Cancelled',
  'Payment Failed',
  'Invite Sent',
  'Integration Connected',
  'Data Imported',
];

function name(over: Partial<EventNameFact> = {}): EventNameFact {
  return {
    rawName: 'workspace_setup_done',
    eventCount: 120,
    distinctUsers: 80,
    medianSequencePosition: 4,
    properties: [],
    ...over,
  };
}

function input(over: Partial<PromptInput> = {}): PromptInput {
  return {
    productDescription: 'Invoicing for freelancers.',
    productKind: 'self-serve',
    meanings: MEANINGS,
    names: [name()],
    ...over,
  };
}

describe('the prompt that is actually sent (brief §11 scrub check)', () => {
  it('carries the facts the model needs to judge a name', () => {
    const prompt = buildPrompt(
      input({
        names: [
          name({
            rawName: 'invoice_sent',
            properties: [
              { property: 'plan', valueType: 'string', sample: 'pro', distinctValues: 3 },
              { property: 'count', valueType: 'number', sample: '2', distinctValues: 9 },
            ],
          }),
        ],
      }),
    );

    expect(prompt.user).toContain('invoice_sent');
    expect(prompt.user).toContain('Invoicing for freelancers.');
    expect(prompt.user).toContain('plan: string, e.g. pro');
    expect(prompt.user).toContain('usually event #4');
    // The closed set is in the system prompt, so the model cannot invent one.
    expect(prompt.system).toContain('Signed Up');
    expect(prompt.system).toContain('Never invent a meaning');
  });

  it('lets no email, phone, id or token reach the prompt', () => {
    // Every one of these is something a real product puts in a property.
    const prompt = buildPrompt(
      input({
        productDescription: 'Invoicing. Questions to sam@acme.com',
        names: [
          name({
            rawName: 'invoice_sent_to_sam@acme.com',
            properties: [
              { property: 'email', valueType: 'string', sample: 'sam@acme.com', distinctValues: 2 },
              { property: 'name', valueType: 'string', sample: 'Pat Jones', distinctValues: 4 },
              {
                property: 'phone',
                valueType: 'string',
                sample: '+44 7700 900123',
                distinctValues: 2,
              },
              {
                property: 'customer',
                valueType: 'string',
                sample: 'cus_Nf8xKd92LaQq',
                distinctValues: 4,
              },
              {
                property: 'token',
                valueType: 'string',
                sample: 'key_live_EXAMPLEONLYNOTREAL',
                distinctValues: 1,
              },
              {
                property: 'ref',
                valueType: 'string',
                sample: 'https://acme.com/r?t=secret',
                distinctValues: 3,
              },
              { property: 'ip', valueType: 'string', sample: '203.0.113.9', distinctValues: 5 },
              { property: 'plan', valueType: 'string', sample: 'pro', distinctValues: 3 },
            ],
          }),
        ],
      }),
    );

    const everything = `${prompt.system}\n${prompt.user}`;
    for (const secret of [
      'sam@acme.com',
      'Pat Jones',
      '7700 900123',
      'cus_Nf8xKd92LaQq',
      'key_live_EXAMPLEONLYNOTREAL',
      'secret',
      '203.0.113.9',
    ]) {
      expect(everything, `"${secret}" reached the prompt`).not.toContain(secret);
    }

    // The property KEYS are still there — the model needs to know an `email`
    // property exists to recognise a signup — and the safe sample survived.
    expect(prompt.user).toContain('email: string');
    expect(prompt.user).toContain('plan: string, e.g. pro');

    // Every drop is recorded with its reason, so an audit can show what happened.
    expect(prompt.dropped.length).toBeGreaterThanOrEqual(7);
    expect(prompt.dropped.map((d) => d.reason).join(' ')).toMatch(
      /email|personal|prefixed-id|url|ip/,
    );
  });

  it('caps the prompt at the 60 most common names', () => {
    const many = Array.from({ length: 200 }, (_, i) =>
      name({ rawName: `event_${i}`, eventCount: i }),
    );
    const prompt = buildPrompt(input({ names: many }));

    expect(prompt.user).toContain(`${MAX_NAMES_IN_PROMPT} of 200`);
    // The most common are kept, not the first 60 alphabetically.
    expect(prompt.user).toContain('"event_199"');
    expect(prompt.user).not.toContain('"event_0"');
  });

  it('stays near the brief’s 4,000-token budget', () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      name({
        rawName: `some_product_event_${i}`,
        properties: [
          { property: 'plan', valueType: 'string', sample: 'pro', distinctValues: 3 },
          { property: 'step', valueType: 'string', sample: 'bank', distinctValues: 5 },
        ],
      }),
    );
    const estimate = estimateTokens(buildPrompt(input({ names: many })));
    // Brief §7: "roughly 4,000 input". A large margin, because a prompt that has
    // grown tenfold is the thing worth catching.
    expect(estimate).toBeLessThan(8000);
  });
});

describe('reading the model’s reply', () => {
  const ok = (text: string): Ask =>
    vi.fn().mockResolvedValue({ text, inputTokens: 3800, outputTokens: 420 });

  it('accepts a well-formed reply', async () => {
    const outcome = await suggestMappings(
      input(),
      ok(
        '{"mappings":[{"raw_name":"workspace_setup_done","canonical":"Activated","confidence":"high","reason":"It is the last onboarding step."}]}',
      ),
    );

    expect(outcome.failure).toBeNull();
    expect(outcome.attempts).toBe(1);
    expect(outcome.suggestions).toEqual([
      {
        rawName: 'workspace_setup_done',
        canonical: 'Activated',
        confidence: 'high',
        reason: 'It is the last onboarding step.',
      },
    ]);
    expect(outcome.inputTokens).toBe(3800);
  });

  it('digs the JSON out of a fenced or chatty reply', async () => {
    const outcome = await suggestMappings(
      input(),
      ok(
        'Here is what I found:\n```json\n{"mappings":[{"raw_name":"workspace_setup_done","canonical":"Activated","confidence":"medium","reason":"Looks like activation."}]}\n```\nHope that helps.',
      ),
    );
    expect(outcome.suggestions[0]?.canonical).toBe('Activated');
  });

  it('refuses a meaning that is not on the list', () => {
    // A hallucinated meaning would silently move a founder's numbers.
    const parsed = parseSuggestions(
      '{"mappings":[{"raw_name":"workspace_setup_done","canonical":"Workspace Created","confidence":"high","reason":"x"}]}',
      input(),
    );
    expect(parsed.ok).toBe(false);
  });

  it('refuses a name we never sent', () => {
    const parsed = parseSuggestions(
      '{"mappings":[{"raw_name":"an_event_that_does_not_exist","canonical":"Activated","confidence":"high","reason":"x"}]}',
      input(),
    );
    expect(parsed.ok).toBe(false);
  });

  it('keeps one meaning for one name, so nothing double-counts', () => {
    const two = input({ names: [name({ rawName: 'a' }), name({ rawName: 'b' })] });
    const parsed = parseSuggestions(
      '{"mappings":[{"raw_name":"a","canonical":"Activated","confidence":"high","reason":"x"},{"raw_name":"b","canonical":"Activated","confidence":"high","reason":"y"}]}',
      two,
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.suggestions).toHaveLength(1);
      expect(parsed.suggestions[0]?.rawName).toBe('a');
    }
  });

  it('accepts null as a real answer', () => {
    const parsed = parseSuggestions(
      '{"mappings":[{"raw_name":"workspace_setup_done","canonical":null,"confidence":"low","reason":"Nothing fits."}]}',
      input(),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.suggestions[0]?.canonical).toBeNull();
  });

  it('falls back to low confidence and a placeholder reason', () => {
    const parsed = parseSuggestions(
      '{"mappings":[{"raw_name":"workspace_setup_done","canonical":"Activated","confidence":"extremely","reason":""}]}',
      input(),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.suggestions[0]?.confidence).toBe('low');
      expect(parsed.suggestions[0]?.reason).toBe('No reason given.');
    }
  });

  it('retries once, telling the model what was wrong', async () => {
    const ask = vi
      .fn()
      .mockResolvedValueOnce({ text: 'I think it is probably activation?' })
      .mockResolvedValueOnce({
        text: '{"mappings":[{"raw_name":"workspace_setup_done","canonical":"Activated","confidence":"high","reason":"ok"}]}',
      });

    const outcome = await suggestMappings(input(), ask);

    expect(outcome.attempts).toBe(2);
    expect(outcome.failure).toBeNull();
    expect(outcome.suggestions).toHaveLength(1);
    // The retry says what was wrong; repeating the same prompt usually repeats the
    // same answer.
    expect(String(ask.mock.calls[1]?.[0]?.user)).toContain('previous reply was unusable');
  });

  it('gives up after one retry and records why, leaving the Inbox usable', async () => {
    const ask = vi.fn().mockResolvedValue({ text: 'no json here at all' });
    const outcome = await suggestMappings(input(), ask);

    expect(outcome.attempts).toBe(2);
    expect(outcome.suggestions).toEqual([]);
    expect(outcome.failure).toContain('no JSON');
    // Brief §7: "If the call fails, the Inbox still works by hand." So this does
    // not throw — the founder maps by hand and nothing is blocked.
  });

  it('survives the model call throwing', async () => {
    const ask = vi.fn().mockRejectedValue(new Error('upstream is down'));
    const outcome = await suggestMappings(input(), ask);
    expect(outcome.failure).toContain('upstream is down');
    expect(outcome.suggestions).toEqual([]);
  });

  it('does not call the model at all when there is nothing to map', async () => {
    const ask = vi.fn();
    const outcome = await suggestMappings(input({ names: [] }), ask);
    expect(ask).not.toHaveBeenCalled();
    expect(outcome.suggestions).toEqual([]);
  });
});

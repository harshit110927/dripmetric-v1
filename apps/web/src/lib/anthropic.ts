import Anthropic from '@anthropic-ai/sdk';
import type { Ask, AskResult } from '@dripmetric/engine';
import { webEnv } from './env';

/**
 * The real model call (brief §7: "a real call behind an env var, a mock in tests").
 *
 * The engine takes an injected `ask` function and knows nothing about this file, so
 * tests use a mock and never reach the network or spend money (CLAUDE.md rule 3).
 * This is the only place in the codebase that talks to Anthropic.
 *
 * Verified against @anthropic-ai/sdk 1.3.0 on 2026-10-29. Three things that are easy
 * to get wrong and are checked here:
 *
 *  - `temperature` is NOT sent. On API version 2026-10-21 a Messages request
 *    carrying `temperature`, `top_p` or `top_k` is rejected with a 400 on every
 *    model.
 *  - `thinking` is NOT sent either. On Haiku 5.5 adaptive thinking is on by default
 *    and a thinking budget is a 400; depth is controlled by `effort` instead.
 *  - A reply can stop with `stop_reason: "refusal"` and HTTP 200. Reading `content`
 *    without checking that first would parse an empty reply and report it as a
 *    model that answered badly.
 */

/** Enough for 60 mappings with a sentence each; the brief budgets about 1,000. */
export const MAX_OUTPUT_TOKENS = 8_000;

/**
 * Mapping is a classification over short facts, not a reasoning problem, so the
 * cheapest depth is the right one. Raise it if the suggestions get worse.
 */
const EFFORT = 'low' as const;

/** Null when no key is configured: the caller falls back to mapping by hand. */
export function anthropicAsk(): Ask | null {
  const env = webEnv();
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const client = new Anthropic({ apiKey });

  return async ({ system, user }): Promise<AskResult> => {
    const response = await client.messages.create({
      model: env.ANTHROPIC_MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      output_config: { effort: EFFORT },
      system,
      messages: [{ role: 'user', content: user }],
    });

    if (response.stop_reason === 'refusal') {
      // The suggester records a failure and the Inbox still works by hand. Mapping
      // event names should never trip a safety classifier, so if this ever fires it
      // is worth seeing rather than retrying.
      throw new Error(
        `The model declined to answer (${response.stop_details?.category ?? 'no category'}).`,
      );
    }

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('\n');

    return {
      text,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    };
  };
}

/** Shown on the Inbox screen so the founder knows whether the button will work. */
export function suggestionsConfigured(): boolean {
  return Boolean(webEnv().ANTHROPIC_API_KEY);
}

import { describe, expect, it } from 'vitest';
import { anthropicAsk, suggestionsConfigured, MAX_OUTPUT_TOKENS } from '../anthropic';

/**
 * The one guard worth having here: with no key configured, there is no model call.
 *
 * CLAUDE.md rule 3 — tests never call a paid API. `vitest.setup.ts` deliberately
 * leaves ANTHROPIC_API_KEY unset, so this test also proves the whole suite cannot
 * spend money through this path: `runSuggestions` is never reached without an `ask`.
 */
describe('the model call', () => {
  it('is absent when no key is configured, so the Inbox works by hand', () => {
    expect(process.env['ANTHROPIC_API_KEY']).toBeFalsy();
    expect(anthropicAsk()).toBeNull();
    expect(suggestionsConfigured()).toBe(false);
  });

  it('budgets enough output for sixty mappings with a sentence each', () => {
    // The brief budgets about 1,000 output tokens; a cap below that would truncate
    // the JSON and the parser would reject a reply the model got right.
    expect(MAX_OUTPUT_TOKENS).toBeGreaterThan(2_000);
  });
});

/**
 * Pure engines: event mapping (M5), funnel and timing (M6), intent (M7), leaks (M8).
 *
 * Every function here takes its facts as arguments and does no I/O (CLAUDE.md rule 9).
 * Workers load the facts, call the engine and store the result, so the simulator and
 * the time-travel tests can move the clock themselves. ESLint enforces the no-clock
 * rule for this package.
 */
export {
  scrubSample,
  scrubEventName,
  isPersonalKey,
  looksPersonal,
  valueTypeOf,
  REDACTED,
  MAX_SAMPLE_LENGTH,
  MAX_DISTINCT_FOR_SAMPLE,
} from './mapping/scrub.js';
export type { ScrubResult } from './mapping/scrub.js';

export {
  buildPrompt,
  estimateTokens,
  MAX_NAMES_IN_PROMPT,
  MAX_PROPERTIES_PER_NAME,
} from './mapping/prompt.js';
export type { BuiltPrompt, PromptInput, EventNameFact, PropertyFact } from './mapping/prompt.js';

export { suggestMappings, parseSuggestions, CONFIDENCES, MAX_ATTEMPTS } from './mapping/suggest.js';
export type {
  Ask,
  AskOptions,
  AskResult,
  Confidence,
  Suggestion,
  SuggestOutcome,
} from './mapping/suggest.js';

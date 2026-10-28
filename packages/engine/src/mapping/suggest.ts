import { buildPrompt, estimateTokens, type BuiltPrompt, type PromptInput } from './prompt.js';

/**
 * AI-suggested mappings (brief §7, settled decision 10).
 *
 * "Output: JSON {raw_name, canonical, confidence, reason}, validated against a
 * schema with one retry. Keep the model id, price and prompt in config. If the call
 * fails, the Inbox still works by hand."
 *
 * The model is reached through an injected `ask` function rather than an SDK. Three
 * reasons: tests mock it without touching the network (CLAUDE.md rule 3), the engine
 * package stays pure and dependency-free, and swapping models is a change in config
 * rather than in this file.
 */

export const CONFIDENCES = ['high', 'medium', 'low'] as const;
export type Confidence = (typeof CONFIDENCES)[number];

export interface Suggestion {
  rawName: string;
  /** null means "nothing fits", which is a real answer and better than a bad guess. */
  canonical: string | null;
  confidence: Confidence;
  /** One sentence, shown to the founder before they confirm. */
  reason: string;
}

export interface AskOptions {
  system: string;
  user: string;
}

export interface AskResult {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
}

/** What the caller injects: one call to a model, or a mock. */
export type Ask = (options: AskOptions) => Promise<AskResult>;

export interface SuggestOutcome {
  suggestions: Suggestion[];
  /** What the scrubber removed on the way to the prompt. Audited. */
  dropped: BuiltPrompt['dropped'];
  estimatedInputTokens: number;
  inputTokens: number | null;
  outputTokens: number | null;
  /** Set when the model could not be used at all; the Inbox still works by hand. */
  failure: string | null;
  /** How many attempts were made. The brief allows one retry. */
  attempts: number;
}

export const MAX_ATTEMPTS = 2;

export async function suggestMappings(input: PromptInput, ask: Ask): Promise<SuggestOutcome> {
  const prompt = buildPrompt(input);
  const outcome: SuggestOutcome = {
    suggestions: [],
    dropped: prompt.dropped,
    estimatedInputTokens: estimateTokens(prompt),
    inputTokens: null,
    outputTokens: null,
    failure: null,
    attempts: 0,
  };

  if (input.names.length === 0) return outcome;

  let lastProblem = 'unknown';

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    outcome.attempts = attempt;
    try {
      const result = await ask({
        system: prompt.system,
        // On the retry, say what was wrong with the first reply. A model given the
        // specific problem usually fixes it; one given the same prompt usually
        // repeats itself.
        user:
          attempt === 1
            ? prompt.user
            : `${prompt.user}\n\nYour previous reply was unusable: ${lastProblem}\nReply with JSON only.`,
      });

      outcome.inputTokens = result.inputTokens ?? null;
      outcome.outputTokens = result.outputTokens ?? null;

      const parsed = parseSuggestions(result.text, input);
      if (parsed.ok) {
        outcome.suggestions = parsed.suggestions;
        outcome.failure = null;
        return outcome;
      }
      lastProblem = parsed.problem;
    } catch (error) {
      lastProblem = error instanceof Error ? error.message : String(error);
    }
  }

  // The Inbox works by hand without this, so a failure is recorded and not thrown.
  outcome.failure = lastProblem;
  return outcome;
}

type ParseResult = { ok: true; suggestions: Suggestion[] } | { ok: false; problem: string };

/**
 * Validates the reply against the schema (brief §7).
 *
 * Strict on purpose. A hallucinated meaning that slipped through would silently move
 * a founder's numbers, and they would have no way to tell.
 */
export function parseSuggestions(text: string, input: PromptInput): ParseResult {
  const json = extractJson(text);
  if (json === null) return { ok: false, problem: 'no JSON object found in the reply' };

  let body: unknown;
  try {
    body = JSON.parse(json);
  } catch (error) {
    return { ok: false, problem: `the JSON did not parse: ${String(error)}` };
  }

  const mappings = (body as { mappings?: unknown }).mappings;
  if (!Array.isArray(mappings)) return { ok: false, problem: 'no "mappings" array' };

  const knownNames = new Set(input.names.map((n) => n.rawName));
  const allowed = new Set(input.meanings);
  const suggestions: Suggestion[] = [];
  const usedMeanings = new Set<string>();

  for (const entry of mappings) {
    if (typeof entry !== 'object' || entry === null) continue;
    const row = entry as Record<string, unknown>;

    const rawName = typeof row['raw_name'] === 'string' ? row['raw_name'] : null;
    // A name we never sent is a hallucination; mapping it would create a dictionary
    // entry for an event that does not exist.
    if (rawName === null || !knownNames.has(rawName)) continue;

    const canonicalValue = row['canonical'];
    let canonical: string | null = null;
    if (typeof canonicalValue === 'string' && canonicalValue.length > 0) {
      // Founders cannot invent meanings, and neither can the model.
      if (!allowed.has(canonicalValue)) continue;
      // One meaning, one name: two names both mapped to Activated would double-count.
      if (usedMeanings.has(canonicalValue)) continue;
      usedMeanings.add(canonicalValue);
      canonical = canonicalValue;
    }

    const confidence = CONFIDENCES.includes(row['confidence'] as Confidence)
      ? (row['confidence'] as Confidence)
      : 'low';

    const reason =
      typeof row['reason'] === 'string' && row['reason'].trim().length > 0
        ? row['reason'].trim().slice(0, 300)
        : 'No reason given.';

    suggestions.push({ rawName, canonical, confidence, reason });
  }

  if (suggestions.length === 0) {
    return { ok: false, problem: 'none of the mappings referred to an event we sent' };
  }
  return { ok: true, suggestions };
}

/** Models sometimes wrap JSON in prose or a fence, whatever the instruction said. */
function extractJson(text: string): string | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  return candidate.slice(start, end + 1);
}

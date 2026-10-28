import { scrubEventName, scrubSample } from './scrub.js';

/**
 * Building the mapping prompt (brief §7).
 *
 * "Input: the distinct raw event names (top 60 by volume), their property keys,
 * shape-only samples (the type, and a value only when the property has few distinct
 * short values), typical position in user sequences, and the product's one-line
 * description. Roughly 4,000 input and 1,000 output tokens."
 *
 * A pure function: facts in, a string out. That is what lets the test assert on
 * exactly what would be sent (brief §11) without a network call or a mock model.
 */

/** Brief §7: "the distinct raw event names (top 60 by volume)". */
export const MAX_NAMES_IN_PROMPT = 60;
/** Enough to show the shape, few enough to leave room for 60 names. */
export const MAX_PROPERTIES_PER_NAME = 8;

export interface PropertyFact {
  property: string;
  valueType: string;
  /** A representative value, or null. Scrubbed before it gets here OR by us. */
  sample: string | null;
  distinctValues: number;
}

export interface EventNameFact {
  rawName: string;
  eventCount: number;
  distinctUsers: number;
  /** Where this name usually falls in a person's sequence, 0 being first. */
  medianSequencePosition: number | null;
  properties: PropertyFact[];
}

export interface PromptInput {
  /** The founder's one-line description of their product. */
  productDescription: string;
  /** self-serve | team | developer. Shapes which meanings are plausible. */
  productKind: string;
  names: EventNameFact[];
  /** The canonical meanings a name may be mapped to. Nothing else is allowed. */
  meanings: readonly string[];
}

export interface BuiltPrompt {
  system: string;
  user: string;
  /** Every value that was dropped, and why. For the test and for an audit. */
  dropped: { rawName: string; property: string; reason: string }[];
}

/**
 * The system prompt.
 *
 * It says "reply with JSON only" because the reply is schema-validated with one
 * retry (brief §7), and it names the closed set of meanings because founders cannot
 * invent new ones — a model that returns `Workspace Created` has produced something
 * the engines cannot read.
 */
function systemPrompt(meanings: readonly string[]): string {
  return [
    'You map a SaaS product’s own event names onto a fixed vocabulary.',
    '',
    'You will be given a product description and a list of event names, each with the',
    'property keys it carries, the shape of those properties, and where the event',
    'usually falls in a user’s sequence. Values that could identify a person have',
    'already been removed, so judge a name by its words, its properties and its',
    'position, not by any example data.',
    '',
    'Map each name to exactly one of these meanings, or to null:',
    ...meanings.map((m) => `  - ${m}`),
    '',
    'Rules:',
    '  - Use null when nothing fits well. A wrong mapping is worse than none, because',
    '    it silently moves a founder’s numbers.',
    '  - Never invent a meaning that is not on the list.',
    '  - One meaning may be used by at most one name. If two names compete, pick the',
    '    better fit and leave the other null.',
    '  - confidence is "high" when the name and its properties both agree, "medium"',
    '    when the name alone is suggestive, "low" when you are mostly guessing.',
    '  - reason is one short sentence a non-technical founder would understand. It is',
    '    shown to them before they confirm.',
    '',
    'Reply with JSON only, no prose, in this shape:',
    '{"mappings":[{"raw_name":"...","canonical":"..."|null,"confidence":"high"|"medium"|"low","reason":"..."}]}',
  ].join('\n');
}

export function buildPrompt(input: PromptInput): BuiltPrompt {
  const dropped: BuiltPrompt['dropped'] = [];
  const lines: string[] = [];

  lines.push(`Product: ${scrubEventName(input.productDescription || '(not described)')}`);
  lines.push(`Kind: ${input.productKind}`);
  lines.push('');
  lines.push(
    `Events (${Math.min(input.names.length, MAX_NAMES_IN_PROMPT)} of ${input.names.length}, most common first):`,
  );

  const byVolume = [...input.names]
    .sort((a, b) => b.eventCount - a.eventCount)
    .slice(0, MAX_NAMES_IN_PROMPT);

  for (const name of byVolume) {
    const safeName = scrubEventName(name.rawName);
    const position =
      name.medianSequencePosition === null
        ? 'position unknown'
        : `usually event #${Math.round(name.medianSequencePosition)} for a user`;

    lines.push('');
    lines.push(
      `- "${safeName}" — ${name.eventCount} times, ${name.distinctUsers} users, ${position}`,
    );

    const properties = name.properties.slice(0, MAX_PROPERTIES_PER_NAME);
    if (properties.length === 0) {
      lines.push('    no properties');
      continue;
    }

    for (const property of properties) {
      // Scrubbed HERE, at the last moment before the prompt exists, even though the
      // samples stored in the database were already scrubbed on the way in. Two
      // gates, because one of them failing silently is the whole risk.
      const result = scrubSample(property.property, property.sample, property.distinctValues);
      if (result.reason !== null && property.sample !== null) {
        dropped.push({ rawName: name.rawName, property: property.property, reason: result.reason });
      }

      const shown = result.value === null ? '' : `, e.g. ${result.value}`;
      lines.push(
        `    ${property.property}: ${property.valueType}${shown} (${property.distinctValues} distinct)`,
      );
    }
  }

  return { system: systemPrompt(input.meanings), user: lines.join('\n'), dropped };
}

/** A rough token estimate, so a run's cost is knowable before it happens. */
export function estimateTokens(prompt: BuiltPrompt): number {
  // About four characters a token for English text. Good enough to catch a prompt
  // that has grown by an order of magnitude.
  return Math.ceil((prompt.system.length + prompt.user.length) / 4);
}

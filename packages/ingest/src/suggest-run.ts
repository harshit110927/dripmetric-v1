import {
  currentProject,
  inbox,
  recordSuggestionRun,
  storeSuggestions,
  type DictionaryEntry,
  type ScopedDb,
} from '@dripmetric/db';
import { CANONICAL_MEANINGS } from '@dripmetric/catalog';
import {
  suggestMappings,
  type Ask,
  type EventNameFact,
  type PromptInput,
  type SuggestOutcome,
} from '@dripmetric/engine';
import { refreshDictionaryFacts } from './dictionary-facts.js';

/**
 * One suggestion run, end to end (brief §7).
 *
 * The three parts stay apart on purpose: the database knows the facts, the engine
 * knows the rules and the prompt, and the model is an injected function. This file is
 * the only thing that knows all three, and it is fifty lines, which is the point —
 * tests drive it with a mock `ask` and never touch the network (CLAUDE.md rule 3).
 *
 * It lives here, next to `recompute.ts` and `dictionary-facts.ts`, because this
 * package is the one place allowed to depend on both `@dripmetric/db` and
 * `@dripmetric/engine`. The web app supplies only the real `ask`; the worker could
 * call the same function unchanged.
 */

export interface SuggestionRun {
  outcome: SuggestOutcome;
  /** How many Inbox rows now carry a proposal. */
  stored: number;
  /** Names considered. Fewer than the Inbox when the prompt cap bites. */
  considered: number;
  /**
   * Every value the scrubber withheld on the way to the stored facts, and why.
   *
   * This is the audit record of what was NOT sent to the model, and it has to come
   * from the first gate: by the time the prompt is built the samples are already
   * null, so `outcome.dropped` is empty in the normal case. A non-empty
   * `outcome.dropped` means a stored sample was itself unsafe, which is a bug in
   * the first gate rather than a routine event.
   */
  withheld: { property: string; reason: string }[];
}

/** The names the model is asked about: everything still waiting in the Inbox. */
export function promptInputFrom(
  entries: readonly DictionaryEntry[],
  settings: { productDescription: string; productKind: string },
): PromptInput {
  const names: EventNameFact[] = entries.map((entry) => ({
    rawName: entry.rawName,
    eventCount: entry.eventCount,
    distinctUsers: entry.distinctUsers,
    medianSequencePosition: entry.medianSequencePosition,
    properties: entry.properties.map((property) => ({
      property: property.property,
      valueType: property.valueType,
      sample: property.sample,
      distinctValues: property.distinctValues,
    })),
  }));

  return {
    productDescription: settings.productDescription,
    productKind: settings.productKind,
    names,
    // Founders cannot invent meanings, and neither can the model.
    meanings: CANONICAL_MEANINGS,
  };
}

export async function runSuggestions(
  db: ScopedDb,
  actorUserId: string | null,
  now: Date,
  ask: Ask,
): Promise<SuggestionRun> {
  // Property keys, shape-only samples and sequence positions, refreshed first: a
  // prompt built from stale facts would ask about events as they looked last week.
  // This is also where the scrubber runs, so `facts.withheld` is the record of what
  // was kept back.
  const facts = await refreshDictionaryFacts(db, now);

  const project = await currentProject(db);
  const waiting = await inbox(db);

  const input = promptInputFrom(waiting, {
    productDescription: project.settings.productDescription,
    productKind: project.settings.productKind,
  });

  const outcome = await suggestMappings(input, ask);

  const stored = await storeSuggestions(
    db,
    outcome.suggestions.map((suggestion) => ({
      rawName: suggestion.rawName,
      canonical: suggestion.canonical,
      confidence: suggestion.confidence,
      reason: suggestion.reason,
    })),
  );

  await recordSuggestionRun(db, now, outcome.inputTokens, outcome.outputTokens);

  /*
   * What the scrubber withheld is audited.
   *
   * The brief's own exit check is that no email, phone, id or token reaches the
   * prompt. The test proves the rule; this row is how we would know afterwards, for
   * a real project, what the rule actually did.
   *
   * Both gates are recorded. `withheld` is the normal one. `droppedAtPrompt` should
   * always be empty — if it is not, a sample that was stored as safe was not, and
   * that is worth finding in the log rather than inferring later.
   */
  await db.exec(
    `INSERT INTO audit_log (project_id, actor_user_id, action, details)
     VALUES ($1, $2, 'mapping.suggested', $3)`,
    [
      db.projectId,
      actorUserId,
      JSON.stringify({
        considered: input.names.length,
        suggested: outcome.suggestions.length,
        stored,
        attempts: outcome.attempts,
        failure: outcome.failure,
        estimatedInputTokens: outcome.estimatedInputTokens,
        inputTokens: outcome.inputTokens,
        outputTokens: outcome.outputTokens,
        withheld: facts.withheld,
        droppedAtPrompt: outcome.dropped,
      }),
    ],
  );

  return { outcome, stored, considered: input.names.length, withheld: facts.withheld };
}

import type { ScopedDb } from './scope.js';
import { currentProject } from './projects.js';
import type { ProjectSettingsValue } from './settings.js';

/**
 * The five product facts and setup logic (brief §2, settled decision 9).
 *
 * "Each project ends setup with five facts the founder confirms, pre-filled from the
 * first 100 events where possible: the steps, the activation line, the paid event,
 * the price, and whether there is a trial."
 *
 * Two rules do the work here:
 *
 *  - **The paid event is required to finish setup.** Without it there is no revenue,
 *    so "intent but didn't pay" and potential revenue are not numbers we could
 *    compute wrong — they are numbers we cannot compute at all (settled decision 9).
 *  - **The dashboard works before setup is finished.** Nothing here gates the rest
 *    of the product. An unconfirmed fact is a missing explanation, not a locked door.
 *
 * The VALUES live where they are already used — the funnel tables and
 * `projects.settings`. This file records only which of them the founder has
 * confirmed, because a default we guessed and a fact they checked are not the same
 * thing, and every number has to be able to say which one it rests on.
 */

export const PRODUCT_FACTS = ['steps', 'activation', 'paidEvent', 'price', 'trial'] as const;
export type ProductFact = (typeof PRODUCT_FACTS)[number];

/** Settled decision 9. The one fact setup cannot finish without. */
export const PAID_EVENT_FACT: ProductFact = 'paidEvent';
/** The canonical meaning that makes the paid event real. */
export const PAID_EVENT_NAME = 'Subscription Started';

const CONFIRMED_COLUMN: Record<ProductFact, string> = {
  steps: 'steps_confirmed_at',
  activation: 'activation_confirmed_at',
  paidEvent: 'paid_event_confirmed_at',
  price: 'price_confirmed_at',
  trial: 'trial_confirmed_at',
};

export interface FactState {
  fact: ProductFact;
  /** What the founder sees as the question. Plain language, their terms. */
  question: string;
  confirmedAt: Date | null;
  /** The current value, in words. Null when there is nothing to confirm yet. */
  value: string | null;
  /**
   * Where the value came from: `founder` once they have confirmed it, `observed`
   * when we pre-filled it from their events, `default` when it is our assumption,
   * and `missing` when there is nothing to show.
   */
  origin: 'founder' | 'observed' | 'default' | 'missing';
  /** Why this fact matters, in one sentence, for the founder. */
  why: string;
  /** True when this fact can be confirmed right now. */
  ready: boolean;
  /** Set when it cannot: the plain reason. */
  blockedBecause: string | null;
}

export interface SetupState {
  facts: FactState[];
  confirmedCount: number;
  /** Null until all five are confirmed. */
  completedAt: Date | null;
  /** Settled decision 9: is a paid event actually arriving? */
  paidEventArriving: boolean;
  /** What is still missing before setup can finish, in the founder's words. */
  remaining: string[];
  suggestionsRunAt: Date | null;
  suggestionsInputTokens: number | null;
  suggestionsOutputTokens: number | null;
}

interface FactsRow {
  steps_confirmed_at: Date | null;
  activation_confirmed_at: Date | null;
  paid_event_confirmed_at: Date | null;
  price_confirmed_at: Date | null;
  trial_confirmed_at: Date | null;
  setup_completed_at: Date | null;
  suggestions_run_at: Date | null;
  suggestions_input_tokens: number | null;
  suggestions_output_tokens: number | null;
}

const FACTS_COLUMNS = `
  steps_confirmed_at, activation_confirmed_at, paid_event_confirmed_at,
  price_confirmed_at, trial_confirmed_at, setup_completed_at,
  suggestions_run_at, suggestions_input_tokens, suggestions_output_tokens
`;

/** Reads the row, creating it on first sight so the setup screen always has one. */
async function factsRow(db: ScopedDb): Promise<FactsRow> {
  return db.one<FactsRow>(
    `INSERT INTO product_facts (project_id) VALUES ($1)
     ON CONFLICT (project_id) DO UPDATE SET project_id = product_facts.project_id
     RETURNING ${FACTS_COLUMNS}`,
    [db.projectId],
  );
}

/** The whole setup screen in one read. */
export async function setupState(db: ScopedDb): Promise<SetupState> {
  const row = await factsRow(db);
  const project = await currentProject(db);
  const observed = await observeFacts(db);

  const facts: FactState[] = [
    stepsFact(row, observed),
    activationFact(row, observed),
    paidEventFact(row, observed),
    priceFact(row, project.settings),
    trialFact(row, project.settings),
  ];

  const remaining = facts.filter((f) => f.confirmedAt === null).map((f) => f.question);

  return {
    facts,
    confirmedCount: facts.filter((f) => f.confirmedAt !== null).length,
    completedAt: row.setup_completed_at,
    paidEventArriving: observed.paidEventArriving,
    remaining,
    suggestionsRunAt: row.suggestions_run_at,
    suggestionsInputTokens: row.suggestions_input_tokens,
    suggestionsOutputTokens: row.suggestions_output_tokens,
  };
}

/**
 * What the events themselves say, pre-filled "from the first 100 events where
 * possible" (brief §2). None of this is a decision; it is a draft for the founder.
 */
interface Observed {
  steps: { label: string; position: number }[];
  activationStep: string | null;
  paidEventArriving: boolean;
  /** The founder's own name for the paid event, if a mapping confirms one. */
  paidEventRawName: string | null;
}

async function observeFacts(db: ScopedDb): Promise<Observed> {
  const steps = await db.query<{ label: string; position: number; importance: string }>(
    `SELECT s.label, s.position, s.importance
       FROM funnel_steps s
       JOIN funnels f ON f.project_id = s.project_id AND f.id = s.funnel_id
      WHERE s.project_id = $1 AND f.is_active
      ORDER BY s.position`,
    [db.projectId],
  );

  const paid = await db.maybeOne<{ raw_name: string; event_count: string }>(
    `SELECT raw_name, event_count
       FROM event_names
      WHERE project_id = $1 AND canonical = $2 AND status = 'confirmed'
      ORDER BY event_count DESC
      LIMIT 1`,
    [db.projectId, PAID_EVENT_NAME],
  );

  const activation = await db.maybeOne<{ raw_name: string }>(
    `SELECT raw_name FROM event_names
      WHERE project_id = $1 AND canonical = 'Activated' AND status = 'confirmed'
      LIMIT 1`,
    [db.projectId],
  );

  return {
    steps: steps.map((s) => ({ label: s.label, position: s.position })),
    activationStep: activation?.raw_name ?? null,
    // A mapped paid event with no events behind it is not a paid event yet.
    paidEventArriving: paid !== null && Number(paid.event_count) > 0,
    paidEventRawName: paid?.raw_name ?? null,
  };
}

function stepsFact(row: FactsRow, observed: Observed): FactState {
  const confirmed = row.steps_confirmed_at;
  const has = observed.steps.length > 0;
  return {
    fact: 'steps',
    question: 'What are the steps between signing up and paying?',
    confirmedAt: confirmed,
    value: has ? observed.steps.map((s) => s.label).join(' → ') : null,
    origin: confirmed ? 'founder' : has ? 'observed' : 'missing',
    why: 'Every stall, every leak and every timing number is measured against these steps.',
    ready: has,
    blockedBecause: has ? null : 'Add at least one step first.',
  };
}

function activationFact(row: FactsRow, observed: Observed): FactState {
  const confirmed = row.activation_confirmed_at;
  return {
    fact: 'activation',
    question: 'Which moment means someone is really using the product?',
    confirmedAt: confirmed,
    value: observed.activationStep,
    origin: confirmed ? 'founder' : observed.activationStep ? 'observed' : 'missing',
    why: 'This is the line between someone who tried it and someone who uses it.',
    ready: observed.activationStep !== null,
    blockedBecause:
      observed.activationStep === null
        ? 'Map one of your events to "Activated" in the Inbox first.'
        : null,
  };
}

function paidEventFact(row: FactsRow, observed: Observed): FactState {
  const confirmed = row.paid_event_confirmed_at;
  return {
    fact: 'paidEvent',
    question: 'Which event means someone has paid?',
    confirmedAt: confirmed,
    value: observed.paidEventRawName,
    origin: confirmed ? 'founder' : observed.paidEventRawName ? 'observed' : 'missing',
    // Settled decision 9, in the founder's words.
    why: 'Without it we can show you where people drop out, but not what it costs you.',
    ready: observed.paidEventRawName !== null,
    blockedBecause:
      observed.paidEventRawName === null
        ? `Send "${PAID_EVENT_NAME}" from your server, or map one of your own events to it in the Inbox.`
        : null,
  };
}

function priceFact(row: FactsRow, settings: ProjectSettingsValue): FactState {
  const confirmed = row.price_confirmed_at;
  const amount = settings.listPriceAmount;
  return {
    fact: 'price',
    question: 'What does your product cost?',
    confirmedAt: confirmed,
    value:
      amount === null
        ? null
        : `${formatMoney(amount, settings.listPriceCurrency)} per ${settings.listPriceInterval}`,
    origin: confirmed ? 'founder' : amount === null ? 'missing' : 'default',
    why: 'Every leak is shown in money, and this is where the money comes from.',
    // The price is a number the founder types; there is nothing to wait for.
    ready: true,
    blockedBecause: null,
  };
}

function trialFact(row: FactsRow, settings: ProjectSettingsValue): FactState {
  const confirmed = row.trial_confirmed_at;
  const days = settings.trialDays;
  return {
    fact: 'trial',
    question: 'Is there a trial, and how long is it?',
    confirmedAt: confirmed,
    value: days === null ? 'No trial' : `${days} days`,
    origin: confirmed ? 'founder' : 'default',
    why: `It sets how long we wait before calling someone "interested but didn't pay" (currently ${settings.didntPayWindowDays} days).`,
    ready: true,
    blockedBecause: null,
  };
}

/** Minor units and a currency code, never a float (CLAUDE.md invariants). */
function formatMoney(minorUnits: number, currency: string): string {
  const major = (minorUnits / 100).toFixed(2);
  return `${major} ${currency.toUpperCase()}`;
}

export interface ConfirmResult {
  confirmed: boolean;
  /** Set when the fact could not be confirmed: the plain reason. */
  refusedBecause: string | null;
  setupCompleted: boolean;
}

/**
 * The founder confirms one fact.
 *
 * Refuses a fact that is not ready — confirming "which event means someone paid"
 * when no such event exists would record a decision about nothing, and the screens
 * would then claim a fact they do not have.
 */
export async function confirmFact(
  db: ScopedDb,
  fact: ProductFact,
  actorUserId: string | null,
  now: Date,
): Promise<ConfirmResult> {
  const before = await setupState(db);
  const state = before.facts.find((f) => f.fact === fact);
  if (!state) return { confirmed: false, refusedBecause: 'Unknown fact.', setupCompleted: false };
  if (!state.ready) {
    return {
      confirmed: false,
      refusedBecause: state.blockedBecause ?? 'Not ready to confirm yet.',
      setupCompleted: false,
    };
  }

  await db.exec(
    `UPDATE product_facts SET ${CONFIRMED_COLUMN[fact]} = $2, updated_at = $2 WHERE project_id = $1`,
    [db.projectId, now],
  );

  const completed = await completeSetupIfReady(db, now);

  await db.exec(
    `INSERT INTO audit_log (project_id, actor_user_id, action, subject, details)
     VALUES ($1, $2, 'fact.confirmed', $3, $4)`,
    [db.projectId, actorUserId, fact, JSON.stringify({ value: state.value })],
  );

  return { confirmed: true, refusedBecause: null, setupCompleted: completed };
}

/** Undoes a confirmation, which also reopens setup. */
export async function unconfirmFact(
  db: ScopedDb,
  fact: ProductFact,
  actorUserId: string | null,
): Promise<void> {
  await db.exec(
    `UPDATE product_facts
        SET ${CONFIRMED_COLUMN[fact]} = NULL, setup_completed_at = NULL, updated_at = now()
      WHERE project_id = $1`,
    [db.projectId],
  );
  await db.exec(
    `INSERT INTO audit_log (project_id, actor_user_id, action, subject)
     VALUES ($1, $2, 'fact.unconfirmed', $3)`,
    [db.projectId, actorUserId, fact],
  );
}

/**
 * Setup is finished when all five facts are confirmed — and the paid event is one of
 * the five, so settled decision 9 is enforced by the same condition rather than by a
 * second rule that could drift from it.
 */
async function completeSetupIfReady(db: ScopedDb, now: Date): Promise<boolean> {
  // No row comes back when a fact is still missing, which is the answer "not yet".
  const row = await db.maybeOne<{ completed_at: Date }>(
    `UPDATE product_facts
        SET setup_completed_at = COALESCE(setup_completed_at, $2)
      WHERE project_id = $1
        AND steps_confirmed_at IS NOT NULL
        AND activation_confirmed_at IS NOT NULL
        AND paid_event_confirmed_at IS NOT NULL
        AND price_confirmed_at IS NOT NULL
        AND trial_confirmed_at IS NOT NULL
      RETURNING setup_completed_at AS completed_at`,
    [db.projectId, now],
  );
  return row !== null;
}

/**
 * Records what a suggestion run cost.
 *
 * The brief keeps the model id and price in config so a run's cost is knowable; this
 * stores what it actually was, so a founder's bill is never a surprise to us either.
 */
export async function recordSuggestionRun(
  db: ScopedDb,
  now: Date,
  inputTokens: number | null,
  outputTokens: number | null,
): Promise<void> {
  await db.exec(
    `INSERT INTO product_facts
       (project_id, suggestions_run_at, suggestions_input_tokens, suggestions_output_tokens)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (project_id) DO UPDATE SET
       suggestions_run_at = EXCLUDED.suggestions_run_at,
       suggestions_input_tokens = EXCLUDED.suggestions_input_tokens,
       suggestions_output_tokens = EXCLUDED.suggestions_output_tokens,
       updated_at = EXCLUDED.suggestions_run_at`,
    [db.projectId, now, inputTokens, outputTokens],
  );
}

/**
 * Whether revenue numbers can be shown at all (settled decision 9).
 *
 * Read by the dashboard and by the coverage checklist. One function, so "no paid
 * event" means exactly one thing everywhere.
 */
export async function paidEventArriving(db: ScopedDb): Promise<boolean> {
  const row = await db.maybeOne<{ event_count: string }>(
    `SELECT event_count FROM event_names
      WHERE project_id = $1 AND canonical = $2 AND status = 'confirmed' AND event_count > 0
      LIMIT 1`,
    [db.projectId, PAID_EVENT_NAME],
  );
  return row !== null;
}

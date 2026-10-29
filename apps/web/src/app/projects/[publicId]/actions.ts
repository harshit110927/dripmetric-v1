'use server';

import { revalidatePath } from 'next/cache';
import {
  confirmFact,
  confirmMapping,
  ignoreName,
  markChange,
  resolveTag,
  revealPersonByKey,
  unconfirmFact,
  unfreezeThresholds,
  updateSettings,
  PRODUCT_FACTS,
  type ProductFact,
} from '@dripmetric/db';
import { CANONICAL_MEANINGS } from '@dripmetric/catalog';
import { queueRecompute, runSuggestions } from '@dripmetric/ingest';
import { withOwnedProject } from '@/lib/project-access';
import { anthropicAsk } from '@/lib/anthropic';
import { invalidateDashboard } from '@/lib/dashboard';

/**
 * The setup and Inbox actions (brief §7).
 *
 * Thin adapters, like the ingest routes: parse the form, call the repository or the
 * job, revalidate. Every decision they can make is made in `@dripmetric/db` or
 * `@dripmetric/ingest`, where it is tested without a browser.
 */

function paths(publicId: string): void {
  revalidatePath(`/projects/${publicId}/setup`);
  revalidatePath(`/projects/${publicId}/inbox`);
}

function isProductFact(value: string): value is ProductFact {
  return (PRODUCT_FACTS as readonly string[]).includes(value);
}

export async function confirmFactAction(formData: FormData): Promise<void> {
  const publicId = String(formData.get('publicId') ?? '');
  const fact = String(formData.get('fact') ?? '');
  if (!isProductFact(fact)) return;

  await withOwnedProject(publicId, (db, _project, user) =>
    confirmFact(db, fact, user.id, new Date()),
  );
  paths(publicId);
}

export async function unconfirmFactAction(formData: FormData): Promise<void> {
  const publicId = String(formData.get('publicId') ?? '');
  const fact = String(formData.get('fact') ?? '');
  if (!isProductFact(fact)) return;

  await withOwnedProject(publicId, (db, _project, user) => unconfirmFact(db, fact, user.id));
  paths(publicId);
}

/**
 * Price and trial, the two facts the founder types rather than confirms.
 *
 * Money is minor units plus a currency code, never a float (CLAUDE.md invariants), so
 * the pounds-and-pence the founder types is converted here and nowhere else.
 */
export async function saveMoneyFactsAction(formData: FormData): Promise<void> {
  const publicId = String(formData.get('publicId') ?? '');
  const price = String(formData.get('price') ?? '').trim();
  const currency = String(formData.get('currency') ?? 'usd').trim();
  const interval = String(formData.get('interval') ?? 'month');
  const trial = String(formData.get('trialDays') ?? '').trim();

  const major = Number.parseFloat(price);
  const days = Number.parseInt(trial, 10);

  await withOwnedProject(publicId, async (db, _project, user) => {
    await updateSettings(db, user.id, {
      listPriceAmount: Number.isFinite(major) ? Math.round(major * 100) : null,
      listPriceCurrency: /^[a-z]{3}$/i.test(currency) ? currency.toLowerCase() : 'usd',
      listPriceInterval: interval === 'year' ? 'year' : 'month',
      trialDays: Number.isInteger(days) && days >= 0 ? days : null,
    });
  });
  paths(publicId);
}

/**
 * The founder confirms a mapping, and history is rebuilt (brief §7).
 *
 * `confirmMapping` says whether the MEANING changed; only then is there anything to
 * recompute. Queuing a run is a row, not a queue call: the worker finds it. That is
 * what keeps a queue client out of the request path.
 */
export async function confirmMappingAction(formData: FormData): Promise<void> {
  const publicId = String(formData.get('publicId') ?? '');
  const rawName = String(formData.get('rawName') ?? '');
  const choice = String(formData.get('canonical') ?? '');
  if (rawName.length === 0) return;

  // Founders cannot invent meanings (brief §7). An unknown value means "none".
  const canonical = (CANONICAL_MEANINGS as readonly string[]).includes(choice) ? choice : null;

  await withOwnedProject(publicId, async (db, _project, user) => {
    const changed = await confirmMapping(db, rawName, canonical, user.id, new Date());
    if (changed) await queueRecompute(db, 'mapping');
  });
  paths(publicId);
}

export async function ignoreNameAction(formData: FormData): Promise<void> {
  const publicId = String(formData.get('publicId') ?? '');
  const rawName = String(formData.get('rawName') ?? '');
  if (rawName.length === 0) return;

  await withOwnedProject(publicId, async (db, _project, user) => {
    await ignoreName(db, rawName, user.id);
    // An ignored name stops counting, so anything built from it has to be rebuilt.
    await queueRecompute(db, 'mapping');
  });
  paths(publicId);
}

/**
 * Spends a reveal on one person (brief §2, §9).
 *
 * The form posts the masked TAG, not an id: the row it came from deliberately carries
 * no identifier, which is the whole point of the masked shape. `resolveTag` finds the
 * person behind it.
 */
export async function revealAction(formData: FormData): Promise<void> {
  const publicId = String(formData.get('publicId') ?? '');
  const tag = String(formData.get('tag') ?? '');
  if (tag.length === 0) return;

  await withOwnedProject(publicId, async (db, project, user) => {
    const userKey = await resolveTag(db, tag);
    if (userKey === null) return;
    await revealPersonByKey(db, userKey, user.id, new Date());
    invalidateDashboard(project.id);
  });
  revalidatePath(`/projects/${publicId}/dashboard`);
}

/**
 * Marks a change (brief §8.1, §9's Changes module).
 *
 * Freezing the thresholds is the point: without it a before-and-after is measured
 * against a bar that moved while the founder was waiting.
 */
export async function markChangeAction(formData: FormData): Promise<void> {
  const publicId = String(formData.get('publicId') ?? '');
  const note = String(formData.get('note') ?? '').trim();
  const happened = String(formData.get('happenedAt') ?? '').trim();
  if (note.length === 0) return;

  const happenedAt = happened.length > 0 ? new Date(happened) : new Date();
  if (Number.isNaN(happenedAt.getTime())) return;

  await withOwnedProject(publicId, async (db, project, user) => {
    await markChange(db, { stepId: null, happenedAt, note }, user.id);
    invalidateDashboard(project.id);
  });
  revalidatePath(`/projects/${publicId}/settings`);
  revalidatePath(`/projects/${publicId}/dashboard`);
}

/** Unfreezes the thresholds, so they track the product again. */
export async function unfreezeAction(formData: FormData): Promise<void> {
  const publicId = String(formData.get('publicId') ?? '');
  await withOwnedProject(publicId, async (db, project, user) => {
    await unfreezeThresholds(db, user.id);
    invalidateDashboard(project.id);
  });
  revalidatePath(`/projects/${publicId}/settings`);
}

/** The settings a founder can change from the settings page (brief §9). */
export async function saveSettingsAction(formData: FormData): Promise<void> {
  const publicId = String(formData.get('publicId') ?? '');
  const text = (name: string) => String(formData.get(name) ?? '').trim();
  const list = (name: string) =>
    text(name)
      .split(/[\s,]+/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);

  const windowDays = Number.parseInt(text('didntPayWindowDays'), 10);
  const allowance = Number.parseInt(text('revealAllowance'), 10);

  await withOwnedProject(publicId, async (db, project, user) => {
    await updateSettings(db, user.id, {
      productDescription: text('productDescription').slice(0, 500),
      internalDomains: list('internalDomains'),
      internalEmails: list('internalEmails'),
      brandTerms: list('brandTerms'),
      allowedOrigins: list('allowedOrigins'),
      consentRequired: formData.get('consentRequired') === 'on',
      mobileFirst: formData.get('mobileFirst') === 'on',
      productKind: productKindOf(text('productKind')),
      alertChannel: alertChannelOf(text('alertChannel')),
      ...(Number.isInteger(windowDays) && windowDays > 0 ? { didntPayWindowDays: windowDays } : {}),
      ...(Number.isInteger(allowance) && allowance >= 0 ? { revealAllowance: allowance } : {}),
    });
    invalidateDashboard(project.id);
  });
  revalidatePath(`/projects/${publicId}/settings`);
  revalidatePath(`/projects/${publicId}/dashboard`);
}

function productKindOf(value: string): 'self-serve' | 'team' | 'developer' {
  return value === 'team' || value === 'developer' ? value : 'self-serve';
}

function alertChannelOf(value: string): 'slack' | 'discord' | 'email-digest' | 'none' {
  return value === 'slack' || value === 'discord' || value === 'email-digest' ? value : 'none';
}

/** Asks the model for suggestions. Does nothing if no key is configured. */
export async function suggestMappingsAction(formData: FormData): Promise<void> {
  const publicId = String(formData.get('publicId') ?? '');
  const ask = anthropicAsk();
  if (!ask) return;

  await withOwnedProject(publicId, (db, _project, user) =>
    runSuggestions(db, user.id, new Date(), ask),
  );
  paths(publicId);
}

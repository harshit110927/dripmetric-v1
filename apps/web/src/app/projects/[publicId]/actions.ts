'use server';

import { revalidatePath } from 'next/cache';
import {
  confirmFact,
  confirmMapping,
  ignoreName,
  unconfirmFact,
  updateSettings,
  PRODUCT_FACTS,
  type ProductFact,
} from '@dripmetric/db';
import { CANONICAL_MEANINGS } from '@dripmetric/catalog';
import { queueRecompute, runSuggestions } from '@dripmetric/ingest';
import { withOwnedProject } from '@/lib/project-access';
import { anthropicAsk } from '@/lib/anthropic';

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

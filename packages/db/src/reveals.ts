import { maskTag } from './crypto.js';
import { entitlements, isUnlimited, limitOf, type Entitlements } from './entitlements.js';
import { maskingSecret } from './projects.js';
import type { ScopedDb } from './scope.js';

/**
 * The reveal allowance (brief §2 and §9).
 *
 * A paid project reveals everyone, so none of this applies to it. A free project has
 * an allowance — default 0 — and may spend it on individual people. Each spend is a
 * row and an audit entry, because a reveal is the one action in the product that
 * turns a masked tag into a person's name, and it has to be accountable.
 */

export interface RevealState {
  /** How many this project may spend in total. -1 means no limit. */
  allowance: number;
  spent: number;
  remaining: number;
  /** True when the plan reveals everyone anyway. */
  everyone: boolean;
  /** The people whose names this project has unlocked. */
  revealedUserKeys: Set<number>;
}

export async function revealState(db: ScopedDb): Promise<RevealState> {
  const plan = await entitlements(db);
  const everyone = plan.features.reveal_identity;
  const allowance = limitOf(plan, 'reveal_allowance');

  const rows = await db.query<{ user_key: number }>(
    'SELECT user_key FROM reveals WHERE project_id = $1',
    [db.projectId],
  );
  const spent = rows.length;

  return {
    allowance,
    spent,
    remaining:
      everyone || isUnlimited(allowance)
        ? Number.POSITIVE_INFINITY
        : Math.max(0, allowance - spent),
    everyone,
    revealedUserKeys: new Set(rows.map((row) => row.user_key)),
  };
}

export type RevealOutcome =
  | { revealed: true; remaining: number; alreadyRevealed: boolean }
  | { revealed: false; because: string; remaining: number };

/**
 * Spends one reveal on one person.
 *
 * Refuses rather than silently doing nothing when the allowance is gone, so the
 * screen can say what happened. Revealing someone twice costs nothing: the primary
 * key makes the second attempt a no-op, which is also why the allowance cannot be
 * spent twice on the same person.
 */
export async function revealPersonByKey(
  db: ScopedDb,
  userKey: number,
  actorUserId: string | null,
  now: Date,
): Promise<RevealOutcome> {
  const state = await revealState(db);

  if (state.everyone) {
    return { revealed: true, remaining: Number.POSITIVE_INFINITY, alreadyRevealed: true };
  }
  if (state.revealedUserKeys.has(userKey)) {
    return { revealed: true, remaining: state.remaining, alreadyRevealed: true };
  }
  if (state.remaining <= 0) {
    return {
      revealed: false,
      remaining: 0,
      because:
        state.allowance === 0
          ? 'Names are part of the paid plan. Upgrade to see who these people are.'
          : `You have used all ${state.allowance} of your name reveals.`,
    };
  }

  const inserted = await db.exec(
    `INSERT INTO reveals (project_id, user_key, revealed_by, revealed_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (project_id, user_key) DO NOTHING`,
    [db.projectId, userKey, actorUserId, now],
  );

  // Brief §10: every reveal goes to the audit log.
  await db.exec(
    `INSERT INTO audit_log (project_id, actor_user_id, action, subject, details)
     VALUES ($1, $2, 'identity.revealed', $3, $4)`,
    [
      db.projectId,
      actorUserId,
      String(userKey),
      JSON.stringify({ allowance: state.allowance, spentBefore: state.spent }),
    ],
  );

  return {
    revealed: true,
    remaining: Math.max(0, state.remaining - inserted),
    alreadyRevealed: inserted === 0,
  };
}

/**
 * Finds the person behind a masked tag.
 *
 * The reveal button needs a handle for someone whose row deliberately carries no
 * identifier, and the tag is the only thing on the page. So the tag IS the handle:
 * it is recomputed for each of the project's people and matched.
 *
 * That is O(people) per reveal, which is the right trade. Putting a user key in the
 * masked HTML would have been O(1) and would have put a stable per-person identifier
 * on a page whose whole promise is that it has none — and the exit-check scan would
 * have had to be taught to ignore it, which is how a gate stops being a gate.
 *
 * The HMAC is not reversible, so this is a search rather than a lookup; the free
 * plan's tracked-user limit bounds it.
 */
export async function resolveTag(db: ScopedDb, tag: string): Promise<number | null> {
  const wanted = tag
    .replace(/^User\s+/i, '')
    .trim()
    .toUpperCase();
  if (!/^[0-9A-F]{6}$/.test(wanted)) return null;

  const secret = await maskingSecret(db);
  const rows = await db.query<{ user_key: number; external_id: string }>(
    `SELECT user_key, external_id FROM end_users
      WHERE project_id = $1 AND deleted_at IS NULL`,
    [db.projectId],
  );

  for (const row of rows) {
    if (maskTag(secret, row.external_id) === wanted) return row.user_key;
  }
  return null;
}

/** How the allowance reads on a screen. */
export function revealAllowanceNote(state: RevealState, plan: Entitlements): string {
  if (state.everyone) return 'Your plan shows you who everyone is.';
  if (state.allowance === 0) {
    return `Names are hidden on the ${plan.planCode} plan. Every row has a tag that is stable for that person, so you can follow one through the funnel without knowing who they are.`;
  }
  if (state.remaining <= 0) {
    return `You have used all ${state.allowance} of your name reveals.`;
  }
  return `You can reveal ${state.remaining} more ${state.remaining === 1 ? 'name' : 'names'}.`;
}

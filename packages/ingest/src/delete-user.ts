import { withProject, withoutProject } from '@dripmetric/db';
import { parseKey, keyLookupHash } from '@dripmetric/db';
import { unauthorised } from './errors.js';
import type { IngestResponse } from './types.js';

/**
 * `DELETE /v1/users/:userId` and the SDK's `deleteUser()` (brief section 10).
 *
 * Removes the person's events, traits, sessions, step state, counters and links.
 * The public promise is "within 30 days"; this does it immediately, which is easier
 * to be sure of than a queue.
 *
 * Secret keys only. A browser must never be able to erase someone.
 *
 * Daily summaries are deliberately NOT touched: they hold no personal data, only
 * counts, and deleting them would silently rewrite the founder's history.
 */

export interface DeleteUserResult extends IngestResponse {
  status: 200 | 404;
}

export async function deleteUser(
  token: string | null,
  externalUserId: string,
): Promise<IngestResponse> {
  if (!token) throw unauthorised('No API key.');

  const shape = parseKey(token);
  if (!shape) throw unauthorised('That key is not in the right shape.');
  if (shape.kind !== 'secret') {
    throw unauthorised('Deleting a user needs your secret key, from your server.');
  }

  const key = await withoutProject('resolve-api-key', (db) =>
    db.maybeOne<{ project_id: number }>(
      `SELECT k.project_id
         FROM api_keys k
         JOIN projects p ON p.id = k.project_id
        WHERE k.lookup_hash = $1 AND k.revoked_at IS NULL AND p.deleted_at IS NULL`,
      [keyLookupHash(token)],
    ),
  );
  if (!key) throw unauthorised('That key is not valid, or it has been revoked.');

  return withProject(key.project_id, async (db) => {
    const user = await db.maybeOne<{ user_key: number }>(
      'SELECT user_key FROM end_users WHERE project_id = $1 AND external_id = $2',
      [db.projectId, externalUserId],
    );

    if (!user) {
      // Idempotent: deleting someone who is already gone is a success, not an error.
      return { status: 404, body: { deleted: false, reason: 'No such user.' } };
    }

    const counts = {
      events: 0,
      sessions: 0,
      stepState: 0,
      alerts: 0,
      leaks: 0,
    };

    // Children before parents, so no foreign key ever has to cascade.
    counts.events = await db.exec('DELETE FROM events WHERE project_id = $1 AND user_key = $2', [
      db.projectId,
      user.user_key,
    ]);
    counts.stepState = await db.exec(
      'DELETE FROM user_step_state WHERE project_id = $1 AND user_key = $2',
      [db.projectId, user.user_key],
    );
    await db.exec('DELETE FROM daily_event_counts WHERE project_id = $1 AND user_key = $2', [
      db.projectId,
      user.user_key,
    ]);
    await db.exec('DELETE FROM monthly_active_users WHERE project_id = $1 AND user_key = $2', [
      db.projectId,
      user.user_key,
    ]);
    await db.exec('DELETE FROM anonymous_links WHERE project_id = $1 AND user_key = $2', [
      db.projectId,
      user.user_key,
    ]);
    await db.exec('DELETE FROM account_members WHERE project_id = $1 AND user_key = $2', [
      db.projectId,
      user.user_key,
    ]);
    counts.sessions = await db.exec(
      'DELETE FROM sessions WHERE project_id = $1 AND user_key = $2',
      [db.projectId, user.user_key],
    );

    /*
     * The two tables that identify a person by `subject_key`, not `user_key`.
     *
     * `leak_instances` and `alerts` can be about a user, an account or a STEP, so
     * their subject column is a plain integer with no foreign key — which means
     * nothing cascades when the person goes. Everything else that holds a
     * `user_key` has an ON DELETE CASCADE to `end_users` and goes by itself.
     *
     * This matters more than tidiness on a paid project: an alert's stored sentence
     * can name the person, so leaving the row behind would leave their name in the
     * feed after they asked to be erased. `subject_kind` is checked so a step's
     * collapse alert is never deleted because a user happened to share its id.
     */
    counts.alerts = await db.exec(
      `DELETE FROM alerts
        WHERE project_id = $1 AND subject_kind = 'user' AND subject_key = $2`,
      [db.projectId, user.user_key],
    );
    counts.leaks = await db.exec(
      `DELETE FROM leak_instances
        WHERE project_id = $1 AND subject_kind = 'user' AND subject_key = $2`,
      [db.projectId, user.user_key],
    );

    await db.exec('DELETE FROM end_users WHERE project_id = $1 AND user_key = $2', [
      db.projectId,
      user.user_key,
    ]);

    // Audited, like every reveal and every settings change (brief section 10).
    await db.exec(
      `INSERT INTO audit_log (project_id, action, subject, details)
       VALUES ($1, 'user.deleted', $2, $3)`,
      [db.projectId, externalUserId, JSON.stringify(counts)],
    );

    return { status: 200, body: { deleted: true, removed: counts } };
  });
}

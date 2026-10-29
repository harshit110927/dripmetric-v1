import { checkSignupAllowed, recordSignupAttempt } from './audit-signup.js';
import { createProject, type CreatedProject } from './projects.js';
import { withoutProject } from './scope.js';

/**
 * The email-only instant project (brief §9's free audit).
 *
 * "Email in, project and keys out, the snippet and the AI-coder prompt on screen,
 * then wait for the first event and flip to the live dashboard. A magic link claims
 * the project."
 *
 * The goal is "a real number in under 10 minutes", which rules out a password, a
 * confirmation email before the keys, and anything else that makes someone stop and
 * go to their inbox. So the project exists immediately and the magic link CLAIMS it
 * afterwards — the link is the slow part, and it happens in parallel with them
 * pasting the snippet.
 */

export type AuditStartOutcome =
  | { ok: true; project: CreatedProject; founderUserId: string }
  | { ok: false; because: string; reason: string };

export interface AuditStartInput {
  email: string;
  /** From the forwarded-for header, or null behind a proxy that strips it. */
  ip: string | null;
  /** The project's name. Defaults to the email's domain, which is usually right. */
  name?: string;
  timezone?: string;
}

/**
 * Starts an audit: guards, then a project and keys in one go.
 *
 * `withoutProject` because there is no project yet — this is the function that makes
 * one. The guard and the creation are deliberately NOT one transaction: a refused
 * attempt must still be recorded, or the per-IP count could be reset by whatever made
 * the creation fail.
 */
export async function startFreeAudit(
  input: AuditStartInput,
  now: Date,
): Promise<AuditStartOutcome> {
  const email = input.email.trim().toLowerCase();

  const guard = await withoutProject('resolve-api-key', (db) =>
    checkSignupAllowed(db, email, input.ip, now),
  );

  if (!guard.allowed) {
    await withoutProject('resolve-api-key', (db) =>
      recordSignupAttempt(
        db,
        { email, ip: input.ip, createdProject: false, reason: guard.reason },
        now,
      ),
    );
    return { ok: false, because: guard.because, reason: guard.reason };
  }

  /*
   * The founder row comes first, and the project is owned by it.
   *
   * An unowned project could never be claimed — the magic link has to resolve to
   * somebody — and an unclaimed project is deleted after 30 days by M11's sweep, so
   * an abandoned audit cleans itself up.
   */
  const founder = await withoutProject('resolve-api-key', (db) =>
    db.one<{ id: string }>(
      `INSERT INTO founder_users (email) VALUES ($1)
       ON CONFLICT (lower(email)) DO UPDATE SET last_seen_at = now()
       RETURNING id`,
      [email],
    ),
  );

  const project = await createProject({
    name: input.name?.trim() || defaultName(email),
    ownerUserId: founder.id,
    timezone: input.timezone ?? 'UTC',
    // Theirs to use now; claimed when they click the magic link.
    claimed: false,
  });

  await withoutProject('resolve-api-key', (db) =>
    recordSignupAttempt(db, { email, ip: input.ip, createdProject: true, reason: 'ok' }, now),
  );

  return { ok: true, project, founderUserId: founder.id };
}

/**
 * "acme.com" becomes "Acme".
 *
 * A guess, and a good one: a founder signing up with jo@acme.com is almost always
 * working on Acme. They can rename it, and a name they recognise beats "My project".
 */
function defaultName(email: string): string {
  const domain = email.split('@').pop() ?? '';
  const stem = domain.split('.')[0] ?? '';
  if (stem.length === 0) return 'My product';
  return stem.charAt(0).toUpperCase() + stem.slice(1);
}

export interface FirstEventState {
  /** True once any event has arrived. This is what flips the page to the dashboard. */
  arrived: boolean;
  events: number;
  firstAt: Date | null;
  /** The event names seen so far, for the "we can see X" line. */
  names: string[];
}

/**
 * Has the first event arrived?
 *
 * Polled by the setup screen. Brief §9 allows "server-sent events or polling"; this
 * is the polling half, and it is a count plus the names — because showing a founder
 * "we can see Page Viewed and Signed Up" is what proves the snippet works, more than
 * any number does.
 */
export async function firstEventState(projectId: number, now: Date): Promise<FirstEventState> {
  void now;
  return withoutProject('worker-sweep', async (db) => {
    const row = await db.one<{ n: string; first_at: Date | null }>(
      `SELECT count(*) AS n, min(received_at) AS first_at
         FROM events WHERE project_id = $1`,
      [projectId],
    );
    const names = await db.query<{ name: string }>(
      `SELECT DISTINCT coalesce(canonical, raw_name) AS name
         FROM event_names WHERE project_id = $1 ORDER BY 1 LIMIT 10`,
      [projectId],
    );

    return {
      arrived: Number(row.n) > 0,
      events: Number(row.n),
      firstAt: row.first_at,
      names: names.map((entry) => entry.name),
    };
  });
}

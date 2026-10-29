import {
  encrypt,
  decrypt,
  generateKey,
  keyLookupHash,
  lastFour,
  newProjectMaskingSecret,
} from './index-internal.js';
import { withoutProject, withProject, type ScopedDb, type UnscopedDb } from './scope.js';
import { defaultSettings, parseSettings, type ProjectSettingsValue } from './settings.js';
import type { KeyKind, ProjectMode } from './keys.js';

/**
 * Project creation and lookup (brief sections 4 and 9).
 *
 * Creating a project genuinely starts outside any project, so it runs through the
 * named escape hatch. Everything afterwards is scoped.
 */

export interface Project {
  id: number;
  publicId: string;
  name: string;
  planCode: string;
  timezone: string;
  mode: ProjectMode;
  liveProjectId: number | null;
  settings: ProjectSettingsValue;
  claimedAt: Date | null;
  createdAt: Date;
}

export interface CreatedKey {
  kind: KeyKind;
  mode: ProjectMode;
  /** The full token. For a secret key this is the ONLY time it is ever available. */
  token: string;
  lastFour: string;
}

export interface CreatedProject {
  live: Project;
  test: Project;
  /** Four keys: publishable and secret, for the live project and its test sibling. */
  keys: CreatedKey[];
}

interface ProjectRow {
  id: number;
  public_id: string;
  name: string;
  plan_code: string;
  timezone: string;
  mode: ProjectMode;
  live_project_id: number | null;
  settings: unknown;
  claimed_at: Date | null;
  created_at: Date;
}

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    publicId: row.public_id,
    name: row.name,
    planCode: row.plan_code,
    timezone: row.timezone,
    mode: row.mode,
    liveProjectId: row.live_project_id,
    settings: parseSettings(row.settings),
    claimedAt: row.claimed_at,
    createdAt: row.created_at,
  };
}

const PROJECT_COLUMNS = `
  id, public_id, name, plan_code, timezone, mode, live_project_id,
  settings, claimed_at, created_at
`;

export interface CreateProjectOptions {
  name: string;
  timezone?: string;
  settings?: Partial<ProjectSettingsValue>;
  /** The founder who owns it. Absent for an email-only instant project until claimed. */
  ownerUserId?: string;
  claimExpiresAt?: Date;
  /**
   * Whether the owner has PROVED they own that email.
   *
   * Defaults to true when there is an owner, which is right for a founder who is
   * already signed in. The free audit passes false: the project is theirs to use
   * immediately, but "claimed" means they clicked the magic link — and an unclaimed
   * project is what M11's sweep stops at 14 days and deletes at 30, so an abandoned
   * audit cleans itself up instead of living forever.
   */
  claimed?: boolean;
}

/**
 * Creates a live project, its test sibling and four keys in one transaction.
 *
 * The test sibling exists so staging traffic never lands in production numbers
 * (brief section 10): the test keys write into it, and it is deleted with its parent.
 */
export async function createProject(options: CreateProjectOptions): Promise<CreatedProject> {
  const settings = { ...defaultSettings(), ...(options.settings ?? {}) };

  return withoutProject('create-project', async (db) => {
    const live = await insertProject(db, {
      name: options.name,
      timezone: options.timezone ?? 'UTC',
      mode: 'live',
      liveProjectId: null,
      settings,
      claimExpiresAt: options.claimExpiresAt ?? null,
      claimedAt: options.ownerUserId && options.claimed !== false ? new Date() : null,
    });

    const test = await insertProject(db, {
      name: `${options.name} (test)`,
      timezone: live.timezone,
      mode: 'test',
      liveProjectId: live.id,
      settings,
      claimExpiresAt: null,
      claimedAt: live.claimedAt,
    });

    if (options.ownerUserId) {
      await db.exec(
        `INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'owner'), ($3, $2, 'owner')`,
        [live.id, options.ownerUserId, test.id],
      );
    }

    const keys: CreatedKey[] = [];
    for (const [project, mode] of [
      [live, 'live'],
      [test, 'test'],
    ] as const) {
      for (const kind of ['publishable', 'secret'] as const) {
        keys.push(await insertKey(db, project.id, kind, mode));
      }
    }

    await db.exec(
      `INSERT INTO audit_log (project_id, actor_user_id, action, details)
       VALUES ($1, $2, 'project.created', $3)`,
      [live.id, options.ownerUserId ?? null, JSON.stringify({ testProjectId: test.id })],
    );

    return { live, test, keys };
  });
}

interface InsertProjectArgs {
  name: string;
  timezone: string;
  mode: ProjectMode;
  liveProjectId: number | null;
  settings: ProjectSettingsValue;
  claimExpiresAt: Date | null;
  claimedAt: Date | null;
}

async function insertProject(db: UnscopedDb, args: InsertProjectArgs): Promise<Project> {
  // Each project gets its own masking secret, so a tag cannot be matched across
  // projects (settled decision 6). It is stored envelope-encrypted like any secret.
  const secret = encrypt(newProjectMaskingSecret());
  const row = await db.one<ProjectRow>(
    `INSERT INTO projects
       (name, timezone, mode, live_project_id, settings,
        masking_secret, masking_secret_key_id, claim_expires_at, claimed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING ${PROJECT_COLUMNS}`,
    [
      args.name,
      args.timezone,
      args.mode,
      args.liveProjectId,
      JSON.stringify(args.settings),
      secret.bytes,
      secret.keyId,
      args.claimExpiresAt,
      args.claimedAt,
    ],
  );
  return toProject(row);
}

async function insertKey(
  db: UnscopedDb,
  projectId: number,
  kind: KeyKind,
  mode: ProjectMode,
): Promise<CreatedKey> {
  const token = generateKey(kind, mode);
  await db.exec(
    `INSERT INTO api_keys (project_id, kind, mode, lookup_hash, token, last_four)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      projectId,
      kind,
      mode,
      keyLookupHash(token),
      // A secret key is never stored in the clear: it is shown once and then only
      // its hash survives (brief section 5).
      kind === 'publishable' ? token : null,
      lastFour(token),
    ],
  );
  return { kind, mode, token, lastFour: lastFour(token) };
}

/** Reads a project the caller is already scoped to. */
export async function currentProject(db: ScopedDb): Promise<Project> {
  const row = await db.one<ProjectRow>(
    `SELECT ${PROJECT_COLUMNS} FROM projects WHERE id = $1 AND deleted_at IS NULL`,
    [db.projectId],
  );
  return toProject(row);
}

/** Resolves a project by its public uuid, then runs scoped work inside it. */
export async function withProjectByPublicId<T>(
  publicId: string,
  fn: (db: ScopedDb, project: Project) => Promise<T>,
): Promise<T | null> {
  const id = await withoutProject('founder-auth', async (db) => {
    const row = await db.maybeOne<{ id: number }>(
      'SELECT id FROM projects WHERE public_id = $1 AND deleted_at IS NULL',
      [publicId],
    );
    return row?.id ?? null;
  });
  if (id === null) return null;
  return withProject(id, async (db) => fn(db, await currentProject(db)));
}

/** The project's masking secret, decrypted. Used to build "User A7F2C1". */
export async function maskingSecret(db: ScopedDb): Promise<Buffer> {
  const row = await db.one<{ masking_secret: Buffer; masking_secret_key_id: string }>(
    'SELECT masking_secret, masking_secret_key_id FROM projects WHERE id = $1',
    [db.projectId],
  );
  return decrypt(row.masking_secret, row.masking_secret_key_id);
}

export interface ApiKeyRecord {
  id: string;
  projectId: number;
  kind: KeyKind;
  mode: ProjectMode;
  lastFour: string;
  name: string;
  token: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

export async function listKeys(db: ScopedDb): Promise<ApiKeyRecord[]> {
  const rows = await db.query<{
    id: string;
    project_id: number;
    kind: KeyKind;
    mode: ProjectMode;
    last_four: string;
    name: string;
    token: string | null;
    created_at: Date;
    last_used_at: Date | null;
    revoked_at: Date | null;
  }>(
    `SELECT id, project_id, kind, mode, last_four, name, token, created_at, last_used_at, revoked_at
       FROM api_keys WHERE project_id = $1 ORDER BY created_at`,
    [db.projectId],
  );
  return rows.map((r) => ({
    id: r.id,
    projectId: r.project_id,
    kind: r.kind,
    mode: r.mode,
    lastFour: r.last_four,
    name: r.name,
    token: r.token,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    revokedAt: r.revoked_at,
  }));
}

export async function updateSettings(
  db: ScopedDb,
  actorUserId: string | null,
  patch: Partial<ProjectSettingsValue>,
): Promise<ProjectSettingsValue> {
  const before = (await currentProject(db)).settings;
  const after = parseSettings({ ...before, ...patch });
  await db.exec('UPDATE projects SET settings = $2, updated_at = now() WHERE id = $1', [
    db.projectId,
    JSON.stringify(after),
  ]);
  // Every settings change goes to the audit log (brief section 10).
  await db.exec(
    `INSERT INTO audit_log (project_id, actor_user_id, action, details)
     VALUES ($1, $2, 'settings.changed', $3)`,
    [db.projectId, actorUserId, JSON.stringify({ changed: Object.keys(patch) })],
  );
  return after;
}

/**
 * Every live project with an active funnel, for the worker's funnel sweep (M6).
 *
 * A project with no funnel has nothing to aggregate, and a project in test mode has
 * numbers nobody reads. Runs outside any one project, through the named escape hatch.
 */
export async function projectsWithFunnels(): Promise<number[]> {
  return withoutProject(
    'worker-sweep',
    async (db) => {
      const rows = await db.query<{ id: number }>(
        `SELECT DISTINCT p.id
           FROM projects p
           JOIN funnels f ON f.project_id = p.id AND f.is_active
          WHERE p.deleted_at IS NULL
          ORDER BY p.id`,
      );
      return rows.map((row) => row.id);
    },
    { worker: true },
  );
}

/**
 * Every live project, for the sweeps that are not about the funnel (M10).
 *
 * `projectsWithFunnels` is right for the funnel and leak sweeps — without a
 * confirmed funnel there is no step state to aggregate. It is wrong for alerts and
 * for the weekly report: the report's own headline is "N users with buying intent
 * didn't pay", which needs no funnel at all, and a founder who has wired events but
 * not yet confirmed their steps is exactly the founder most worth emailing.
 *
 * Test-mode projects are excluded. A founder's sandbox should never send them mail.
 */
export async function activeProjects(): Promise<number[]> {
  return withoutProject(
    'worker-sweep',
    async (db) => {
      const rows = await db.query<{ id: number }>(
        `SELECT p.id
           FROM projects p
          WHERE p.deleted_at IS NULL
            AND p.mode = 'live'
          ORDER BY p.id`,
      );
      return rows.map((row) => row.id);
    },
    { worker: true },
  );
}

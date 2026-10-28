/**
 * The public surface of @dripmetric/db.
 *
 * Note what is NOT here: there is no bare `query`, and the pool is not re-exported.
 * Tenant data is reachable only through `withProject()`, or through the named,
 * logged escape hatch `withoutProject(reason, …)`. CLAUDE.md invariant 1, and
 * `src/__tests__/scoping.test.ts` is the proof.
 */
export { withProject, withoutProject, CROSS_PROJECT_REASONS } from './scope.js';
export type { ScopedDb, UnscopedDb, ScopeOptions, CrossProjectReason } from './scope.js';

export { closePools } from './pool.js';
export { dbEnv, resetDbEnvCache } from './env.js';
export type { DbEnv } from './env.js';

export * from './entitlements.js';
export * from './settings.js';
export * from './keys.js';
export {
  encrypt,
  decrypt,
  decryptText,
  lookupHash,
  sameSecret,
  maskTag,
  newProjectMaskingSecret,
  resetKeyringCache,
} from './crypto.js';
export type { Ciphertext } from './crypto.js';

export * from './projects.js';
export * from './dictionary.js';

// Migrations, the schema reset and the `.env` loader live in @dripmetric/db/admin.
// They touch the filesystem and the schema, so the request path must not be able to
// reach them, and keeping them out of here means the web bundle cannot pull them in.

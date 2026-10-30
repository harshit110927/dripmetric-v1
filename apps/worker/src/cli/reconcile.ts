#!/usr/bin/env tsx
/**
 * `pnpm shadow:reconcile` — compares the shadow copy against the primary (M13).
 *
 * The same function the nightly job runs, on demand. It exists as a command because
 * the monthly drills in docs/runbook.md need a way to check the shadow before and
 * after doing something to it, and "wait for 04:23" is not a drill step.
 *
 * Exits non-zero on a gap, so it can be the last line of a drill script and fail
 * loudly rather than printing a difference nobody reads.
 */
import { closePools, describeReconciliation, reconcile, shadowConfigured } from '@dripmetric/db';
import { loadRootEnv } from '@dripmetric/db/admin';

loadRootEnv();

if (!shadowConfigured()) {
  console.error(
    'SHADOW_DATABASE_URL is not set, so there is nothing to reconcile.\n' +
      'Locally: `pnpm shadow:up && pnpm shadow:migrate`, then set it in .env.\n' +
      'Settled decision 1: no real founder data until the shadow copy or Supabase Pro\n' +
      'backups exist.',
  );
  process.exit(1);
}

const result = await reconcile(new Date());
console.log(`\n${describeReconciliation(result)}\n`);

console.log('  table         primary    shadow   missing');
for (const gap of result.gaps) {
  console.log(
    `  ${gap.table.padEnd(12)} ${String(gap.primary).padStart(8)} ` +
      `${String(gap.shadow).padStart(9)} ${String(gap.missing).padStart(9)}`,
  );
}

if (result.latencyMs !== null) console.log(`\n  took ${result.latencyMs}ms`);

await closePools();

/*
 * A gap is an exit code, not a warning.
 *
 * The shadow's whole purpose is being restorable, and a copy that is quietly behind
 * is worse than no copy at all: it invites a restore that loses data while looking
 * like it worked.
 */
if (!result.ran) {
  console.error('\nReconciliation could not run. The shadow is unreachable.');
  process.exit(2);
}
if (!result.clean) {
  console.error('\nThe shadow does not match. See docs/runbook.md, "shadow is behind".');
  process.exit(1);
}
console.log('\nClean.');

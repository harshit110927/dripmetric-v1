#!/usr/bin/env tsx
/**
 * `pnpm db:migrate` and `pnpm db:reset`.
 *
 * Runs as the database OWNER (ADMIN_DATABASE_URL, falling back to DATABASE_URL). It
 * then makes sure the non-owner
 * application role exists, because row-level security does not apply to the owner and
 * the whole point of the role is that it does. In development the role is given a
 * login password so `pnpm dev` can use it; in production the password is set out of
 * band (docs/runbook.md) and this step is skipped.
 */
import pg from 'pg';
import { loadRootEnv } from '../load-env.js';
import { runMigrations, resetDatabase } from '../migrate.js';

loadRootEnv();

const reset = process.argv.includes('--reset');

/*
 * `--shadow` migrates the shadow copy instead (settled decision 1, M13).
 *
 * The SAME migrations, because the shadow's whole purpose is being restorable: a
 * schema that had drifted from the primary would be a copy you could not switch to,
 * which is the one thing it must be. So there is no separate migration set and no
 * way to apply one.
 */
const shadow = process.argv.includes('--shadow');
const url = shadow
  ? process.env['SHADOW_DATABASE_URL']
  : process.env['ADMIN_DATABASE_URL'] || process.env['DATABASE_URL'];

if (!url) {
  console.error(
    shadow
      ? 'SHADOW_DATABASE_URL is not set. `pnpm shadow:up` starts one locally; see docs/runbook.md.'
      : 'ADMIN_DATABASE_URL is not set. Copy .env.example to .env.',
  );
  process.exit(1);
}
if (shadow) console.log('Migrating the SHADOW copy.');

const client = new pg.Client({ connectionString: url });
await client.connect();

try {
  if (reset) {
    console.log('Dropping and recreating the public schema…');
    await resetDatabase(client);
  }

  const { applied, skipped } = await runMigrations(client);
  for (const name of applied) console.log(`applied  ${name}`);
  if (skipped.length > 0) console.log(`${skipped.length} already applied`);
  if (applied.length === 0 && !reset) console.log('Nothing to do: the database is up to date.');

  if (process.env['NODE_ENV'] !== 'production') {
    // Dev-only password, so a fresh clone works with the committed .env.example.
    await client.query(`ALTER ROLE dripmetric_app LOGIN PASSWORD 'dripmetric_app'`);
    console.log('Application role dripmetric_app is ready (development password).');
  }
} finally {
  await client.end();
}

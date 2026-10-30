#!/usr/bin/env node
/**
 * Waits for the Docker Postgres to accept connections, so `pnpm db:up` is reliable.
 *
 * `--shadow` waits for the shadow copy instead (settled decision 1, M13), which runs
 * in its own container on 54330 with its own database name.
 */
import { execFileSync } from 'node:child_process';

const shadow = process.argv.includes('--shadow');
const container = shadow ? 'dripmetric-postgres-shadow' : 'dripmetric-postgres';
const database = shadow ? 'dripmetric_shadow' : 'dripmetric';
const label = shadow ? 'the shadow postgres' : 'postgres';

const deadline = Date.now() + 60_000;
process.stdout.write(`waiting for ${label}`);
for (;;) {
  try {
    execFileSync('docker', ['exec', container, 'pg_isready', '-U', 'dripmetric', '-d', database], {
      stdio: 'ignore',
    });
    console.log(`\n${label} is ready`);
    process.exit(0);
  } catch {
    if (Date.now() > deadline) {
      console.error(`\n${label} did not become ready in 60s. Is Docker running?`);
      process.exit(1);
    }
    process.stdout.write('.');
    await new Promise((r) => setTimeout(r, 1000));
  }
}

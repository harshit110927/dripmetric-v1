#!/usr/bin/env node
/**
 * `node scripts/drill.mjs <name>` — the monthly drills (brief §10, M13).
 *
 * "Scripts for the monthly drills" and "every drill has a written result in
 * docs/runbook.md". So each drill runs, prints what happened, and appends a dated
 * entry to the runbook — because a drill whose result lives in a terminal is a drill
 * nobody can audit next quarter.
 *
 *   node scripts/drill.mjs restore     can the shadow be read as a primary?
 *   node scripts/drill.mjs kill-shadow does ingest survive losing the shadow?
 *   node scripts/drill.mjs reconcile   do the two copies agree right now?
 *   node scripts/drill.mjs list        what drills exist
 */
import { execFileSync } from 'node:child_process';
import { appendFile, readFile } from 'node:fs/promises';

const RUNBOOK = 'docs/runbook.md';

const DRILLS = {
  reconcile: {
    says: 'Compare the shadow against the primary.',
    run() {
      const output = run('pnpm', ['shadow:reconcile']);
      return { ok: output.includes('Clean.'), detail: lastLines(output, 8) };
    },
  },

  'kill-shadow': {
    says: 'Stop the shadow, prove ingest is unaffected, start it again.',
    run() {
      const lines = [];
      lines.push(
        stepped('stop the shadow', () => run('docker', ['stop', 'dripmetric-postgres-shadow'])),
      );
      /*
       * The test is the proof, not a stopwatch here.
       *
       * `shadow.test.ts` already measures ingest with the shadow dead and asserts the
       * request path never touches it. Running that test with the container actually
       * stopped is a stronger version of the same check, and it fails loudly.
       */
      const tested = stepped('ingest with no shadow', () =>
        run('npx', [
          'vitest',
          'run',
          'packages/sim/src/__tests__/shadow.test.ts',
          '-t',
          'does not slow',
        ]),
      );
      lines.push(tested);
      lines.push(
        stepped('start the shadow', () => run('docker', ['start', 'dripmetric-postgres-shadow'])),
      );
      return { ok: tested.includes('ok:'), detail: lines.join('\n') };
    },
  },

  restore: {
    says: 'Read the shadow as if it were the primary, and count what is there.',
    run() {
      /*
       * A read, not a switch.
       *
       * A real restore drill on a real deployment points the app at the shadow and
       * serves traffic from it. Locally the useful half is proving the shadow has the
       * schema AND the rows to do that — if either is missing, the restore plan in
       * the runbook is fiction.
       */
      const counts = run('docker', [
        'exec',
        'dripmetric-postgres-shadow',
        'psql',
        '-U',
        'dripmetric',
        '-d',
        'dripmetric_shadow',
        '-t',
        '-c',
        "SELECT 'events=' || (SELECT count(*) FROM events) || " +
          "' end_users=' || (SELECT count(*) FROM end_users) || " +
          "' projects=' || (SELECT count(*) FROM projects) || " +
          "' tables=' || (SELECT count(*) FROM information_schema.tables WHERE table_schema='public')",
      ]);
      const tables = Number(/tables=(\d+)/.exec(counts)?.[1] ?? 0);
      return {
        // The schema is the thing that makes a restore possible at all.
        ok: tables > 20,
        detail: `${counts.trim()}\n(a restorable shadow needs the full schema, not just rows)`,
      };
    },
  },
};

function run(command, args) {
  try {
    return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    return `${error.stdout ?? ''}${error.stderr ?? ''}`;
  }
}

function stepped(label, fn) {
  const started = Date.now();
  const output = fn();
  const failed = /error|failed|FAIL/i.test(output) && !/0 failed/i.test(output);
  return `  ${failed ? 'FAILED' : 'ok:'} ${label} (${Date.now() - started}ms)`;
}

function lastLines(text, n) {
  return text.trim().split('\n').slice(-n).join('\n');
}

const name = process.argv[2];

if (!name || name === 'list') {
  console.log('\nDrills:\n');
  for (const [key, drill] of Object.entries(DRILLS))
    console.log(`  ${key.padEnd(14)} ${drill.says}`);
  console.log('\nResults are appended to docs/runbook.md.\n');
  process.exit(name ? 0 : 1);
}

const drill = DRILLS[name];
if (!drill) {
  console.error(`No drill called "${name}". Try: ${Object.keys(DRILLS).join(', ')}`);
  process.exit(1);
}

console.log(`\nDRILL: ${name} — ${drill.says}\n`);
const result = drill.run();
console.log(result.detail);
console.log(`\n${result.ok ? 'PASSED' : 'FAILED'}\n`);

/*
 * Appended, never rewritten.
 *
 * The value of a drill log is the history: a restore that took 40 seconds last
 * quarter and 400 this one is the finding, and it is invisible if each run replaces
 * the last.
 */
const entry =
  `\n### ${new Date().toISOString().slice(0, 10)} · drill: ${name} — ` +
  `${result.ok ? 'passed' : 'FAILED'}\n\n` +
  '```\n' +
  `${result.detail.trim()}\n` +
  '```\n';

const existing = await readFile(RUNBOOK, 'utf8').catch(() => '');
if (!existing.includes('## Drill log')) {
  await appendFile(RUNBOOK, '\n## Drill log\n\nAppended by `node scripts/drill.mjs`.\n');
}
await appendFile(RUNBOOK, entry);
console.log(`Written to ${RUNBOOK}`);

process.exit(result.ok ? 0 : 1);

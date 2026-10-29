#!/usr/bin/env tsx
/**
 * `pnpm sim` — generates a run, loads it through the HTTP API and writes the truth
 * file beside it.
 *
 *   pnpm sim --product selfserve --users 300 --seed 1
 *   pnpm sim --product b2b --users 150 --seed 7 --faults duplicates,late-events
 *   pnpm sim --product devtool --users 200 --seed 3 --dry-run
 *
 * Nothing here is shown to a founder, so it prints what an engineer needs: what was
 * generated, what the API said about it, and where the truth file went.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRootEnv } from '@dripmetric/db/admin';
import { closePools, createProject, withProject } from '@dripmetric/db';
import { runSimulation } from './run.js';
import { loadThroughApi } from './load.js';
import { PRODUCT_KEYS, product } from './products/index.js';
import { formatScore, scoreIngest } from './score.js';
import { configureProject } from './setup.js';
import { FAULT_NAMES, type FaultName, type ProductKey } from './types.js';

loadRootEnv();

interface Args {
  product: ProductKey;
  users: number;
  seed: number;
  faults: FaultName[];
  host: string;
  outDir: string;
  dryRun: boolean;
  publishableKey: string | null;
  secretKey: string | null;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };

  const productArg = (get('product') ?? 'selfserve') as ProductKey;
  if (!PRODUCT_KEYS.includes(productArg)) {
    throw new Error(`--product must be one of ${PRODUCT_KEYS.join(', ')}; got "${productArg}".`);
  }

  const faults = (get('faults') ?? '')
    .split(',')
    .map((f) => f.trim())
    .filter(Boolean) as FaultName[];
  for (const fault of faults) {
    if (!FAULT_NAMES.includes(fault)) {
      throw new Error(`--faults must be from ${FAULT_NAMES.join(', ')}; got "${fault}".`);
    }
  }

  const here = dirname(fileURLToPath(import.meta.url));
  return {
    product: productArg,
    users: Number(get('users') ?? 300),
    seed: Number(get('seed') ?? 1),
    faults,
    host: get('host') ?? process.env['APP_URL'] ?? 'http://localhost:3000',
    outDir: resolve(get('out') ?? join(here, '..', '..', '..', '.sim')),
    dryRun: argv.includes('--dry-run'),
    publishableKey: get('publishable-key') ?? null,
    secretKey: get('secret-key') ?? null,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const definition = product(args.product);

  console.log(
    `\nSIMULATED DATA — never shown to a founder as real (CLAUDE.md rule 7)\n` +
      `  product   ${definition.name} (${args.product}): ${definition.description}\n` +
      `  users     ${args.users}\n` +
      `  seed      ${args.seed}\n` +
      `  faults    ${args.faults.length > 0 ? args.faults.join(', ') : 'none'}\n`,
  );

  const run = runSimulation({
    product: args.product,
    users: args.users,
    seed: args.seed,
    faults: args.faults,
  });

  console.log(
    `generated ${run.messages.length.toLocaleString()} messages over ` +
      `${run.truthFile.startedAt.slice(0, 10)} to ${run.truthFile.endedAt.slice(0, 10)}`,
  );
  console.log(
    `  known truth: ${run.truthFile.totals.signedUp} signed up, ` +
      `${run.truthFile.totals.activated} activated, ${run.truthFile.totals.paid} paid, ` +
      `${run.truthFile.totals.stalled} stalled, ` +
      `${run.truthFile.totals.highIntentNoPay} high intent and did not pay, ` +
      `${run.truthFile.totals.filtered} should be filtered out`,
  );
  for (const fault of run.faultLog) console.log(`  fault ${fault.fault}: ${fault.detail}`);

  await mkdir(args.outDir, { recursive: true });
  const stem = `${args.product}-seed${args.seed}-users${args.users}`;
  const truthPath = join(args.outDir, `${stem}.truth.json`);
  await writeFile(truthPath, JSON.stringify(run.truthFile, null, 2));
  console.log(`\ntruth file  ${truthPath}`);

  if (args.dryRun) {
    const messagesPath = join(args.outDir, `${stem}.messages.json`);
    await writeFile(messagesPath, JSON.stringify(run.messages, null, 2));
    console.log(`messages    ${messagesPath}`);
    console.log('\n--dry-run: nothing was sent to the API.');
    return;
  }

  // A fresh project per run, so one run never reads another's numbers.
  let publishableKey: string = args.publishableKey ?? '';
  let secretKey: string = args.secretKey ?? '';
  let projectLabel = 'the keys you passed';
  let projectId: number | null = null;

  if (!publishableKey || !secretKey) {
    const created = await createProject({
      name: `${definition.name} (simulated, seed ${args.seed})`,
      settings: {
        listPriceAmount: definition.listPriceAmount,
        listPriceCurrency: definition.listPriceCurrency,
        trialDays: definition.trialDays,
        productDescription: definition.description,
        // The simulator's own team, so the `internal` persona is filtered as intended.
        internalDomains: ['ledgerly-internal.com'],
        productKind: definition.hasAccounts
          ? 'team'
          : definition.hasPlanLimits
            ? 'developer'
            : 'self-serve',
      },
    });
    publishableKey =
      created.keys.find((key) => key.kind === 'publishable' && key.mode === 'live')?.token ?? '';
    secretKey =
      created.keys.find((key) => key.kind === 'secret' && key.mode === 'live')?.token ?? '';
    projectLabel = `project ${created.live.publicId}`;
    projectId = created.live.id;
    // The funnel, URL rules and the core-action mapping a founder confirms at setup.
    // Without them there is no step state, so no stall is visible to any rule.
    await withProject(created.live.id, (db) => configureProject(db, definition));
    console.log(`project     ${created.live.publicId} ("${created.live.name}")`);
  }

  console.log(`\nloading through ${args.host}/v1/batch using ${projectLabel}…`);

  let lastShown = 0;
  const result = await loadThroughApi(run.messages, {
    host: args.host,
    publishableKey,
    secretKey,
    onProgress: (sent, total) => {
      if (sent - lastShown < 2000 && sent !== total) return;
      lastShown = sent;
      process.stdout.write(`\r  ${sent.toLocaleString()} / ${total.toLocaleString()}`);
    },
  });
  process.stdout.write('\n');

  console.log(
    `\nAPI said: ${result.accepted.toLocaleString()} stored, ` +
      `${result.duplicates.toLocaleString()} duplicates, ` +
      `${result.filtered.toLocaleString()} filtered, ` +
      `${result.errors.reduce((n, e) => n + e.count, 0).toLocaleString()} errors` +
      (result.rateLimited > 0 ? `, ${result.rateLimited} batches rate-limited` : ''),
  );
  for (const error of result.errors) console.log(`  ${error.code}: ${error.count}`);
  console.log(
    `  ${Math.round((result.sent / result.elapsedMs) * 1000).toLocaleString()} messages/second over ${(result.elapsedMs / 1000).toFixed(1)}s`,
  );

  // What the simulator is for: scoring against known truth rather than eyeballing.
  if (projectId !== null) {
    const score = await withProject(projectId, (db) => scoreIngest(db, run.truthFile));
    console.log(`\n${formatScore(score)}`);
    console.log(
      '\n  The leak and intent SHARES (how many stalls were caught, how many leavers\n' +
        '  were flagged) arrive with the engines at M7 and M8. What is scored here is\n' +
        '  whether ingest put the right people and events in the database at all, which\n' +
        '  is the floor those scores stand on.',
    );
  }
}

main()
  .then(() => closePools())
  .catch(async (error: unknown) => {
    console.error(`\nsim failed: ${error instanceof Error ? error.message : String(error)}`);
    await closePools().catch(() => {});
    process.exit(1);
  });

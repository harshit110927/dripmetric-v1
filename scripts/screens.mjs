#!/usr/bin/env node
/**
 * `pnpm screens` — fills a project with simulated data, screenshots every dashboard
 * module into `docs/screens/`, and scans the rendered HTML for a seeded person's
 * email, name and user id.
 *
 * Two of M9's exit checks are about things only a browser can see: "all modules
 * render from simulator data" and "an automated scan shows a free project's API and
 * HTML contain no seeded email, name or user id while a paid project shows them". The
 * data-access layer's own scan lives in `packages/db/src/__tests__/masking.test.ts`;
 * this is the other half, against real HTML.
 *
 * It starts the web server itself, so there is nothing to set up first beyond
 * `pnpm db:up` and a build.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { loadRootEnv } from '@dripmetric/db/admin';
import { closePools, createProject, encrypt, withProject, withoutProject } from '@dripmetric/db';
import { handleBatch, runFunnelDaily, runIntentDaily, runLeakSweep } from '@dripmetric/ingest';
import { runSimulation, product, configureProject } from '@dripmetric/sim';

loadRootEnv();

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const screensDir = join(root, 'docs', 'screens');
const PORT = Number(process.env.SCREENS_PORT ?? 3210);
const BASE = `http://127.0.0.1:${PORT}`;

/** Distinctive enough that finding any of them in the HTML is unambiguous. */
const SEEDED = {
  externalId: 'usr_SEEDED_EXTERNAL_ID_42',
  email: 'seeded.person@scan-example.test',
  name: 'Seeded Scanperson',
  company: 'Scanco Limited',
};
const SECRETS = Object.values(SEEDED);

const FOUNDER_EMAIL = 'screens@example.test';

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36';

async function send(messages, keys) {
  let group = [];
  let serverSide = messages[0]?.serverSide ?? false;

  const flush = async () => {
    if (group.length === 0) return;
    const receivedAt = group.reduce(
      (latest, m) => (new Date(m.at) > latest ? new Date(m.at) : latest),
      new Date(0),
    );
    await handleBatch({
      body: JSON.stringify({
        batch: group.map((m) => m.message),
        sentAt: receivedAt.toISOString(),
      }),
      headers: {
        authorization: `Bearer ${serverSide ? keys.secret : keys.publishable}`,
        'content-type': 'application/json',
        'user-agent': BROWSER_UA,
      },
      receivedAt,
    });
    group = [];
  };

  for (const message of messages) {
    if (message.serverSide !== serverSide || group.length >= 200) {
      await flush();
      serverSide = message.serverSide;
    }
    group.push(message);
  }
  await flush();
}

/** A project with simulated data, the engines run, and one seeded person in it. */
async function buildProject(planCode) {
  const definition = product('selfserve');
  const created = await createProject({
    name: planCode === 'free' ? 'Ledgerly' : 'Ledgerly (paid)',
    settings: {
      listPriceAmount: definition.listPriceAmount,
      listPriceCurrency: definition.listPriceCurrency,
      trialDays: definition.trialDays,
      productDescription: definition.description,
      internalDomains: ['ledgerly-internal.com'],
      productKind: 'self-serve',
    },
  });

  if (planCode !== 'free') {
    await withoutProject('admin-script', (db) =>
      db.exec('UPDATE projects SET plan_code = $2 WHERE id = $1', [created.live.id, planCode]),
    );
  }

  await withProject(created.live.id, (db) => configureProject(db, definition));

  const run = runSimulation({ product: 'selfserve', users: 220, seed: 11 });
  const keys = {
    publishable: created.keys.find((k) => k.kind === 'publishable' && k.mode === 'live').token,
    secret: created.keys.find((k) => k.kind === 'secret' && k.mode === 'live').token,
  };
  await send(run.messages, keys);

  // One person with values we can scan for, placed in the lists the modules show.
  await withProject(created.live.id, async (db) => {
    const email = encrypt(SEEDED.email);
    const names = encrypt(JSON.stringify({ name: SEEDED.name, company: SEEDED.company }));
    const now = new Date(run.truthFile.endedAt);

    const row = await db.one(
      `INSERT INTO end_users (
         project_id, external_id, email_ciphertext, email_key_id, email_type,
         name_traits_ciphertext, name_traits_key_id, traits, country, signed_up_at, last_event_at
       ) VALUES ($1, $2, $3, $4, 'work', $5, $6, '{"plan":"pro"}'::jsonb, 'GB', $7, $7)
       RETURNING user_key`,
      [db.projectId, SEEDED.externalId, email.bytes, email.keyId, names.bytes, names.keyId, now],
    );
    await db.exec(
      `INSERT INTO intent_state (project_id, user_key, last_event_at, base_points, peak_score,
                                 first_high_at, activated, checkout_started, fit)
       VALUES ($1, $2, $3, 82, 82, $3, true, true, '{"workEmail":true}'::jsonb)`,
      [db.projectId, row.user_key, now],
    );
    await db.exec(
      `INSERT INTO leak_instances (project_id, subject_kind, subject_key, leak_type,
                                   episode_key, fired_at, says, details)
       VALUES ($1, 'user', $2, 'last-moment-drop', 'checkout:seeded', $3,
               'They started checking out and no payment arrived.', '{}'::jsonb)`,
      [db.projectId, row.user_key, now],
    );
  });

  const now = new Date(run.truthFile.endedAt);
  await runFunnelDaily(created.live.id, now);
  await runIntentDaily(created.live.id, now);
  await runLeakSweep(created.live.id, now);

  // The founder who will look at it.
  await withoutProject('admin-script', async (db) => {
    const user = await db.one(
      `INSERT INTO founder_users (email) VALUES ($1)
       ON CONFLICT (lower(email)) DO UPDATE SET last_seen_at = now()
       RETURNING id`,
      [FOUNDER_EMAIL],
    );
    await db.exec(
      `INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'owner')
       ON CONFLICT DO NOTHING`,
      [created.live.id, user.id],
    );
  });

  return { publicId: created.live.publicId, projectId: created.live.id };
}

function startServer() {
  const child = spawn(
    'pnpm',
    ['--filter', '@dripmetric/web', 'exec', 'next', 'start', '--port', String(PORT)],
    {
      cwd: root,
      env: { ...process.env, PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.stdout.on('data', () => {});
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  return child;
}

/**
 * Waits for the page's streamed content to be in the live DOM.
 *
 * Next streams server components: the shell arrives first with the Suspense
 * fallback, the real content follows inside a `<template>`, and React swaps it in
 * with its own `$RC` reveal script — which waits for an animation frame and can be
 * up to ~2.3 seconds behind. `networkidle` fires well before that.
 *
 * This was a race the scan had always been running and had simply been winning.
 * `page.content()` includes templates, so the HTML scan for leaked identity was
 * never affected; `locator('section')` only sees the live DOM, so the MODULE checks
 * were. When M11 added a read to the dashboard the page got slower and five of the
 * eight modules started being reported missing — modules that render perfectly well.
 *
 * Waiting for the LAST module is the whole fix: if it is visible, everything above
 * it has been revealed too.
 */
async function settled(page) {
  await page
    .getByRole('heading', { name: 'Did your changes work' })
    .waitFor({ state: 'visible', timeout: 30_000 });
}

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const response = await fetch(`${BASE}/login`);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`the web server did not start on ${BASE}`);
}

async function main() {
  await mkdir(screensDir, { recursive: true });

  /*
   * `next start` serves a build; without one it exits with a message that is easy to
   * miss behind the server's own noise.
   *
   * This check caught a real hole rather than a missing step. The root `build` script
   * used to filter to `./packages/**`, so `next build` never ran in CI — the web app's
   * pages and route handlers were the one part of the codebase CI never compiled, and
   * this script only passed locally because a stale `.next` was lying around. `build`
   * is now `pnpm -r build`.
   */
  if (!existsSync(join(root, 'apps', 'web', '.next', 'BUILD_ID'))) {
    throw new Error(
      'apps/web has no build, so `next start` has nothing to serve. Run `pnpm build` ' +
        '(which must include apps/web, not only ./packages/**).',
    );
  }

  console.log('building the projects…');
  const free = await buildProject('free');
  const paid = await buildProject('starter');
  console.log(`  free  ${free.publicId}`);
  console.log(`  paid  ${paid.publicId}`);

  const server = startServer();
  const findings = [];

  try {
    await waitForServer();

    const browser = await chromium.launch({ args: ['--no-sandbox'] });
    const context = await browser.newContext({
      viewport: { width: 1100, height: 1300 },
      /*
       * 1x, not 2x. These are checked into the repo for a person to read, and at 2x
       * the set was 11 MB — a cost every clone pays for ever, for sharpness nobody
       * needs to read a table.
       */
      deviceScaleFactor: 1,
      userAgent: BROWSER_UA,
    });
    const page = await context.newPage();

    // Sign in through the dev magic-link route, as the M0 flow does.
    const response = await fetch(`${BASE}/dev/login?email=${encodeURIComponent(FOUNDER_EMAIL)}`);
    const { link } = await response.json();
    if (!link) throw new Error('no magic link came back from /dev/login');
    /*
     * The link is built from APP_URL, which points at the port a developer uses.
     * This server is on its own port so it cannot collide with one already running,
     * so the origin is rewritten rather than the environment changed — NODE_ENV has
     * to stay `development` here, because a production build sets `secure` on the
     * session cookie and the screenshots are taken over http.
     */
    const verifyUrl = new URL(link);
    const target = new URL(BASE);
    verifyUrl.protocol = target.protocol;
    verifyUrl.host = target.host;
    await page.goto(verifyUrl.toString(), { waitUntil: 'networkidle' });

    // --- the free project: every module, and the scan ------------------------
    const freeUrl = `${BASE}/projects/${free.publicId}/dashboard`;
    await page.goto(freeUrl, { waitUntil: 'networkidle' });
    await settled(page);
    const freeHtml = await page.content();

    for (const secret of SECRETS) {
      if (freeHtml.includes(secret)) findings.push(`FREE HTML LEAKED: ${secret}`);
    }
    if (!/User [0-9A-F]{6}/.test(freeHtml)) {
      findings.push('FREE HTML had no masked tag, so the scan proved nothing');
    }

    await page.screenshot({ path: join(screensDir, '01-dashboard-free-full.png'), fullPage: true });

    const modules = [
      ['02-leaks', 'Where you are losing people'],
      ['03-funnel', 'Your funnel'],
      ['04-intent', 'Who looks ready to buy'],
      ['05-checkout', 'Checkout'],
      ['06-retention', 'Do they come back'],
      ['07-quiet-payers', 'Paying customers going quiet'],
      ['08-tracking-health', 'Is the tracking healthy'],
      ['09-changes', 'Did your changes work'],
    ];

    for (const [name, heading] of modules) {
      const section = page.locator('section', {
        has: page.getByRole('heading', { name: heading }),
      });
      // Already settled above, so a missing section here is a real absence.
      if ((await section.count()) === 0) {
        findings.push(`MODULE MISSING: ${heading}`);
        continue;
      }
      await section.first().screenshot({ path: join(screensDir, `${name}.png`) });
    }

    // The other screens, so the brief's "screenshots of every module" has the
    // setup and settings pages beside them.
    for (const [name, path] of [
      ['10-setup', 'setup'],
      ['11-inbox', 'inbox'],
      ['12-settings', 'settings'],
    ]) {
      await page.goto(`${BASE}/projects/${free.publicId}/${path}`, { waitUntil: 'networkidle' });
      await page.screenshot({ path: join(screensDir, `${name}.png`), fullPage: true });
    }

    // --- the paid project: the same person, with their name ------------------
    const paidUrl = `${BASE}/projects/${paid.publicId}/dashboard`;
    await page.goto(paidUrl, { waitUntil: 'networkidle' });
    /*
     * Needed for the SCREENSHOT, not for the scan.
     *
     * The identity check below reads `page.content()`, which includes the streamed
     * `<template>`, so it was never affected by the reveal race. The full-page
     * screenshot is: without this it captures the Suspense fallback, and the picture
     * in `docs/screens/` would show a loading state rather than a paid dashboard.
     */
    await settled(page);
    const paidHtml = await page.content();

    for (const secret of [SEEDED.email, SEEDED.name, SEEDED.externalId]) {
      if (!paidHtml.includes(secret)) findings.push(`PAID HTML DID NOT SHOW: ${secret}`);
    }
    await page.screenshot({ path: join(screensDir, '13-dashboard-paid.png'), fullPage: true });

    await browser.close();
  } finally {
    server.kill('SIGTERM');
  }

  const report = [
    '# Dashboard screenshots and the masking scan',
    '',
    `Generated ${new Date().toISOString()} by \`pnpm screens\`.`,
    '',
    'The data is simulated (CLAUDE.md rule 7). The seeded person used for the scan is',
    `\`${SEEDED.name}\` <${SEEDED.email}>, id \`${SEEDED.externalId}\`.`,
    '',
    findings.length === 0
      ? '**Scan passed.** The free project’s HTML contains none of the seeded strings,' +
        ' every module rendered, and the paid project shows the name, the email and the id.'
      : `**Scan FAILED** with ${findings.length} finding(s):\n\n` +
        findings.map((f) => `- ${f}`).join('\n'),
    '',
  ].join('\n');

  await writeFile(join(screensDir, 'README.md'), report);
  console.log(`\n${report}`);

  await closePools();
  if (findings.length > 0) process.exit(1);
}

main().catch(async (error) => {
  console.error(error);
  await closePools().catch(() => {});
  process.exit(1);
});

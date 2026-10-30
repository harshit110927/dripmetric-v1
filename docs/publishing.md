# Publishing and going live

Everything you have to do outside this repository, in the order to do it, with every
key named and the exact place each one goes.

Nothing here has been done for you. The codebase is **dev-only on purpose** (CLAUDE.md
rule 3): there are no production credentials in it, `.env` is ignored, and
`.env.example` is the committed template.

Read **step 0** before anything else. It is the one that stops you losing a founder's
data.

---

## Step 0 · The gate, before any real data

**Settled decision 1: no real founder data until the shadow copy or Supabase Pro
backups exist. Supabase Free has no backups.**

The code enforces this. In production, creating a live project is refused unless
`BACKUPS_CONFIRMED=true`. It accepts exactly the string `true` — not "yes", "1" or
"TRUE", because a gate that accepts those was never really closed.

Setting that variable is **a statement that backups exist**. It cannot create them and
cannot check them. So before you set it, do one of:

- **Supabase Pro** ($25/month), which gives daily backups; or
- **the shadow copy**, which is built and tested — a second Postgres the worker
  dual-writes to. `pnpm shadow:up`, `pnpm shadow:migrate`, set `SHADOW_DATABASE_URL`.
  `docs/runbook.md` has the restore procedure and the monthly drills.

Until then, use the test projects. They work identically and nothing about them is
precious.

---

## Step 1 · Publish the SDK to npm

The package is `dripmetric`, MIT, and already configured: `files` is limited to
`dist`, `README.md` and `LICENSE`, and `publishConfig` is `{"access": "public",
"provenance": true}`.

**The name may be taken.** Check first:

```bash
npm view dripmetric
```

A 404 means it is free. If it is taken, you need a scope — `@yourname/dripmetric` —
and that changes every import in `docs/`, the examples app and the generated snippets,
so decide now rather than after launch.

Then, from the repository root:

```bash
pnpm sdk:build
```

```bash
cd packages/sdk && npm publish
```

What you need:

| Thing       | Where to get it | Where it goes             |
| ----------- | --------------- | ------------------------- |
| npm account | npmjs.com       | `npm login` once, locally |
| 2FA         | npm settings    | prompted at publish       |

`provenance: true` means npm records which GitHub Actions workflow built the package.
It only works when you publish **from CI**, not from a laptop. Publishing locally will
fail on provenance — either drop that field or publish from a workflow with
`id-token: write` permission.

After publishing, verify the thing a customer actually does:

```bash
cd /tmp && npm init -y && npm install dripmetric && node -e "console.log(Object.keys(require('dripmetric/server')))"
```

The examples app in `examples/next-app` already imports the package through its
`exports` map, and `pnpm build` compiles it — which is why that app is in the build.

---

## Step 2 · The database (Supabase)

Create a project. Then:

| Variable              | Value                                     | Notes           |
| --------------------- | ----------------------------------------- | --------------- |
| `DATABASE_URL`        | the **transaction pooler** URI, port 6543 | for the web app |
| `WORKER_DATABASE_URL` | the **direct/session** URI, port 5432     | for the worker  |
| `ADMIN_DATABASE_URL`  | the direct URI as the owner               | migrations only |

Those are three different connection strings and the distinction matters. The worker
runs pg-boss, which needs advisory locks, `LISTEN/NOTIFY` and long transactions — the
transaction pooler supports none of them. The web app wants the pooler because
serverless functions multiply connections.

Nothing in the codebase names a prepared statement, deliberately, so the same queries
work through both.

Then:

```bash
ADMIN_DATABASE_URL="postgres://..." pnpm db:migrate
```

This also creates the non-owner role `dripmetric_app` that row-level security applies
to. **In production, set that role's password yourself** and point `DATABASE_URL` at
it — the migration only sets a dev password locally.

---

## Step 3 · The web app (Vercel)

Import the repository, set the root to `apps/web`, and add the environment variables
below. `pnpm build` is the build command.

### Required

| Variable             | What it is                   | How to make it                         |
| -------------------- | ---------------------------- | -------------------------------------- |
| `DATABASE_URL`       | pooler URI                   | Supabase                               |
| `ADMIN_DATABASE_URL` | owner URI                    | Supabase                               |
| `APP_URL`            | `https://app.yourdomain.com` | your domain                            |
| `AUTH_SECRET`        | session signing, ≥32 chars   | `openssl rand -base64 32`              |
| `ENCRYPTION_KEYS`    | `k1:<base64 32 bytes>`       | `echo "k1:$(openssl rand -base64 32)"` |
| `NODE_ENV`           | `production`                 | Vercel sets it                         |

**`ENCRYPTION_KEYS` is the one you must not lose.** It encrypts end-user emails, name
traits, webhook URLs and each project's masking secret. Lose it and that data is
unreadable — there is no recovery path, by design. Keep a copy somewhere other than
Vercel.

To rotate: put the new key FIRST and keep the old one. `k2:new,k1:old`. New writes use
`k2`, old rows still decrypt with `k1`, and nothing needs a backfill.

### Optional, by feature

| Variable                                      | Turns on                           | Without it                                                            |
| --------------------------------------------- | ---------------------------------- | --------------------------------------------------------------------- |
| `RESEND_API_KEY`                              | magic links, weekly report, digest | mail goes to a console mailbox; **login will not work in production** |
| `EMAIL_FROM`                                  | the From address                   | `Dripmetric <hello@dripmetric.com>`                                   |
| `ANTHROPIC_API_KEY`                           | AI mapping suggestions             | the Inbox works by hand                                               |
| `ANTHROPIC_MODEL`                             | model override                     | `claude-haiku-5-5`                                                    |
| `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET`     | Slack install                      | the in-app feed still works                                           |
| `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` | Discord install                    | same                                                                  |
| `SLACK_OAUTH_BASE` / `DISCORD_OAUTH_BASE`     | real endpoints                     | defaults to the in-app **mock**                                       |
| `BACKUPS_CONFIRMED`                           | live projects                      | only test projects can be created                                     |
| `SHADOW_DATABASE_URL`                         | the shadow copy                    | shadow paths do nothing                                               |

**`SLACK_OAUTH_BASE` and `DISCORD_OAUTH_BASE` default to the local mock at
`/dev/oauth/<kind>`.** In production set them to the real endpoints
(`https://slack.com/oauth/v2` and `https://discord.com/api/oauth2`) or the install
flow will hand out webhooks pointing at `.test` hostnames that cannot resolve. The
mock route itself refuses to run in production, so it fails closed rather than
silently.

### The two chat apps

**Slack:** api.slack.com → create an app → OAuth & Permissions → add the
`incoming-webhook` scope → set the redirect URL to
`https://your-app/projects/<id>/integrations/slack/callback`. Copy the client id and
secret.

**Discord:** discord.com/developers → New Application → OAuth2 → add the
`webhook.incoming` scope → add the same shape of redirect. Copy the client id and
secret.

**Resend:** resend.com → verify your sending domain (DNS records) → create an API key.
Domain verification is the slow part; start it early.

---

## Step 4 · The worker

The worker is a **long-running process**, not a serverless function. It runs the
sweeps, the alerts, the reports, retention and the shadow copy. Vercel cannot host it.

Railway, Fly, Render or any small VM will. It needs:

```bash
pnpm install --frozen-lockfile && pnpm build
```

```bash
node apps/worker/dist/main.js
```

Give it `WORKER_DATABASE_URL` (the direct connection), `DATABASE_URL`,
`ENCRYPTION_KEYS`, `APP_URL`, and `RESEND_API_KEY` if you want the weekly report sent.
`SHADOW_DATABASE_URL` if you have a shadow.

**Without the worker, the product looks broken in a specific way:** events still
arrive and the dashboard still renders, but nothing is ever aggregated, no leak is ever
found, no alert is ever sent and nothing is ever deleted. It is not optional.

---

## Step 5 · Attach an error service (optional)

Error reporting is a seam, not an SDK. To attach Sentry:

```bash
pnpm add @sentry/node --filter @dripmetric/worker
```

Then at the top of `apps/worker/src/main.ts`:

```ts
import * as Sentry from '@sentry/node';
import { setErrorReporter } from '@dripmetric/db';

Sentry.init({ dsn: process.env.SENTRY_DSN });
setErrorReporter((error, context) => {
  Sentry.captureException(error, { tags: { where: context.where } });
});
```

Without it, `reportError` writes the same structured JSON as every other log line, so
a deployment with no error service still has a searchable error record.

---

## Step 6 · Before you tell anyone

- [ ] `pnpm verify` green, and CI green on the branch
- [ ] `pnpm db:migrate` run against production
- [ ] the `dripmetric_app` role has a password you set, and `DATABASE_URL` uses it
- [ ] `ENCRYPTION_KEYS` backed up somewhere that is not Vercel
- [ ] Resend domain verified, and a magic link actually received
- [ ] `SLACK_OAUTH_BASE` / `DISCORD_OAUTH_BASE` pointed at the real endpoints
- [ ] the worker running, and its startup log read
- [ ] backups real — Supabase Pro or the shadow copy — **then** `BACKUPS_CONFIRMED=true`
- [ ] one real project end to end: email, snippet, first event, dashboard
- [ ] `node scripts/drill.mjs restore` run once against production's shadow

---

## What is not built

Honest list, so nothing here is a surprise later.

- **Stripe.** No connector. "Paid" means a `Subscription Started` event you send.
  Potential revenue is always your list price × a count of people, never observed money.
- **Nudges and recovery.** The brief's later layers. Observe tells you where the leak
  is; it does not act on it.
- **Reveal billing.** `can(project, 'reveal_identity')` and the reveal allowance are
  enforced, but nothing takes payment. Upgrading a project is a database change today.
- **Re-copying a shadow gap.** The reconciliation finds one; closing it for a specific
  window is manual.
- **Tracking health beyond what M11 built.** Missing events, shape drift, double-sends,
  late arrivals and the browser/server share are detected. Nothing watches for a
  property that stops being sent while its event keeps arriving.
- **The legal pages are placeholders** and say so on the page. Unreviewed text that
  reads like a privacy policy is worse than a stated gap.

---

## Where the numbers are

- `docs/cost.md` — measured SDK size, storage per event, the ingest ceiling and what
  it costs to run. Every figure has the command that produced it.
- `docs/load-test.json` — the last load-test ladder.
- `docs/runbook.md` — what to do when something breaks, and the drill log.
- `docs/decisions.md` — every engineering decision, with the reason.
- `docs/progress.md` — the milestones and their exit checks, with measured results.

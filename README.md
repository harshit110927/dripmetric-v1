# Dripmetric v2 — Observe layer

Shows early-stage SaaS founders where, and how much, revenue leaks between a
visitor's first visit and their first payment. **Observe** is the free level: it shows
_where_ and _how much_. Paid plans add _who_, _why_ and _what to do_.

All thirteen milestones (M0–M13) are built on branch `v2-observe`, with each exit
check proven and measured — see `docs/progress.md`. **To take it live, follow
`docs/publishing.md`**, which names every key you need and where it goes.

## Getting started

```bash
pnpm install
pnpm dev
```

`pnpm dev` starts Postgres in Docker, applies the migrations and runs the founder app
on <http://localhost:3000> alongside the worker. There is no email account to set up:
with no `RESEND_API_KEY`, sign-in links are printed to the console and listed at
<http://localhost:3000/dev/mailbox>.

Then: sign in, create a project, copy the keys, and send an event from anywhere.

```bash
curl http://localhost:3000/v1/batch \
  -H "Authorization: Bearer $DRIPMETRIC_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d '{"batch":[{"type":"track","messageId":"test-1","userId":"user_123","event":"Signed Up"}]}'
```

## Commands

```bash
pnpm dev          # Postgres, migrations, web (:3000) and worker
pnpm test         # unit and integration tests (needs Postgres)
pnpm verify       # everything CI runs: lint, format, typecheck, licences, tests
pnpm ready        # format, then verify. Run this before committing.
pnpm db:reset     # drop, recreate and migrate
pnpm sim          # load a simulated product through the real API
pnpm screens      # screenshot every dashboard module and scan for leaked identity
pnpm load         # the load test: ramps until it finds a ceiling, and names it
pnpm shadow:up    # the shadow Postgres (settled decision 1)
```

Not `pnpm ci` or `pnpm licenses`: both are pnpm built-ins that would shadow a script
of the same name. `pnpm check:names` fails the build if that can ever happen again.

## What is here

| Package            | What it is                                                                                                                                                        |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/catalog` | The settled event catalog as typed data: 76 events, 18 context fields, 20 computed signals, the dozen canonical meanings, and the Zod schemas for the wire format |
| `packages/ingest`  | The ingest pipeline, framework-agnostic: auth, limits, dedupe, filters, enrichment, identity, batched writes                                                      |
| `packages/db`      | Plain-SQL migrations, the scoped query helper, envelope encryption, `can(project, feature)`                                                                       |
| `packages/engine`  | Pure functions only: funnel and timing, intent, leaks, alerts, reports, tracking health, snippets. Every one takes `now` and does no I/O                          |
| `packages/sdk`     | The npm package `dripmetric`: `dripmetric/browser` and `dripmetric/server`. Core is 5,018 B gzipped against a 5,120 B budget CI enforces                          |
| `packages/sim`     | The simulator: personas, fault injection, payload emitters for Segment, RudderStack and PostHog, and scoring against known truth                                  |
| `apps/web`         | The founder app, the public API route handlers and the no-code source webhooks                                                                                    |
| `apps/worker`      | pg-boss jobs behind a thin queue adapter: sweeps, alerts, reports, retention, the shadow copy                                                                     |

## What it does

- **Ingest** — one API, Segment's message format, so Segment's own libraries work by
  pointing at our host. Adapters for Segment, RudderStack and PostHog webhooks.
- **A funnel with timing** — drop-off per step, how long each takes, thresholds that
  freeze when you mark a change so a before-and-after is not measured against a
  moving bar.
- **Buying intent** — a score replayed from events, so "when they got hot" is a fact
  about the past rather than when a job happened to run.
- **Nine leaks** — each one a rule you can read, firing once per episode, resetting
  when someone comes back.
- **Masked alerts** — Slack, Discord and an in-app feed. A free project's alerts and
  HTML never contain an email, a name or a user id; a scan of the rendered pages
  proves it in CI.
- **A weekly report** — eight parts, Monday morning in your timezone, with one-click
  unsubscribe.
- **Tracking health** — an event that stops arriving says _tracking broke_, not _your
  users vanished_.

## Documentation

- **`docs/publishing.md` — how to take this live: every key, where it goes, in order**
- `docs/cost.md` — measured SDK size, storage per event and the ingest ceiling
- `docs/runbook.md` — what to do when something breaks, and the drill log
- `docs/openapi.yaml` — the ingest API, also served at `/v1/openapi.json`
- `docs/progress.md` — the milestone plan and what is proven
- `docs/decisions.md` — the settled product decisions and every engineering decision
- `docs/screens/` — a screenshot of every dashboard module, regenerated by CI
- `CLAUDE.md` — the working rules and the hard invariants

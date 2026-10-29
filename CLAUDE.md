# Dripmetric v2 — Observe layer

Shows early-stage SaaS founders where and how much revenue leaks between a visitor's
first visit and their first payment. Observe is the free level: _where_ and _how much_.
Paid adds _who_, _why_ and _what to do_. Stripe, nudges and recovery are later layers.

## Read these first, every session

- `docs/progress.md` — milestones M0–M13 and their exit checks. Current state lives here.
- `docs/decisions.md` — settled product decisions (do not reopen) + every engineering decision.
- This file.

## Working rules

1. **One milestone at a time.** Stop at the end of each; report in ≤12 lines; wait for "continue".
2. **Branch `v2-observe`.** Never push to `main`, never force-push, never rewrite history.
   Commit at least once per milestone.
3. **Dev only.** Local Postgres in Docker. No production credentials. `.env` is ignored,
   `.env.example` is committed. Tests mock Anthropic, Resend, Slack and Discord.
4. **Done means proven.** Exit checks pass, CI green, commands shown. Two habits,
   each learned from a CI failure:
   - Prove a command by running THAT command, not its moving parts: `pnpm verify`,
     not the steps inside it. (`pnpm licenses` was a pnpm built-in and never ran our
     check.)
   - Run `pnpm ready` (format, then verify) as the LAST action before a commit.
     Running it earlier and then editing a doc is what broke `format:check`.
5. **Settled is settled.** `docs/decisions.md` §"Settled product decisions" is closed.
6. **Ask only for product calls** (what is free, prices, promise-changing wording, anything
   that costs money). Everything else: pick a default, record it, carry on.
7. **Plain language for founders.** Short sentences, the founder's own event names, every
   number can show how it is computed, simulated data is always labelled.
8. **Licences.** Nothing GPL/AGPL ships to customers (SDK, web app). MIT/Apache-2.0/BSD
   preferred. `pnpm check:licenses` enforces it in CI. Script names use a colon so a
   pnpm built-in can never shadow them; `pnpm check:names` enforces that.
9. **Time is a parameter.** Every engine function and sweep takes `now`. No hidden clock
   reads inside `packages/engine`. Enforced by lint rule + review.
10. **Derived state is rebuildable.** Step state, scores, leaks and summaries must be
    reproducible from raw events + settings by the idempotent `recompute` job.
11. **Encode rules in code, not memory.** A rule from the brief becomes a named constant
    with a comment naming its brief section (e.g. `// brief §8.2`). Context gets compacted.

## Commands

```
pnpm install                 # install the workspace
pnpm db:up                   # start Postgres in Docker and wait for it
pnpm db:migrate              # apply plain-SQL migrations
pnpm db:reset                # drop, recreate, migrate
pnpm dev                     # web (:3000) + worker, with Postgres already up
pnpm test                    # vitest (unit + integration; needs pnpm db:up)
pnpm lint / pnpm typecheck / pnpm check:licenses
pnpm verify                  # everything CI runs. NOT `pnpm ci`: that is a pnpm built-in
```

## Repo map

```
apps/web          Next.js 16 founder app + public API route handlers (thin adapters only)
apps/worker       Node process: pg-boss jobs (sweeps, summaries, alerts, reports, retention)
packages/catalog  event catalog, context fields, traits, canonical meanings — typed + Zod
packages/ingest   framework-agnostic ingest pipeline (MUST NOT import next/*), plus the
                  dictionary and derived-state jobs (recompute, dictionary facts,
                  suggestion runs): the only package that may use db AND engine
packages/engine   pure functions: funnel+timing, intent, leaks, stats (take `now`, no I/O)
packages/db       plain-SQL migrations, scoped query helpers, can(project, feature)
packages/sdk      npm package `dripmetric` v2 — dripmetric/browser, dripmetric/server
packages/sim      simulator: personas, fault injection, scoring against truth
examples/         sample Next.js app using the SDKs
docs/             progress.md, decisions.md, openapi.yaml, runbook.md, screens/
```

## Hard invariants

- Every tenant query goes through `withProject()` in `packages/db`. A query without a
  project must be impossible to write; `packages/db/src/__tests__/scoping.test.ts` proves it.
- RLS is on and deny-by-default as a backstop.
- All timestamps `timestamptz`, UTC. Money = minor units + currency code, never a float.
- Masking is enforced server-side through `can(project, 'reveal_identity')`. A free
  project's API responses and HTML never contain an email, name, user id or trait.
- Ingest hot path: plain parameterised SQL, batched inserts. No ORM.
- `packages/ingest` and `packages/engine` must not import from `apps/*`.

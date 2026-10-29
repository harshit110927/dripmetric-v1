# Decisions

Two parts. **Part 1 is settled by the founder and closed** — do not reopen; if one looks
wrong, say so in the milestone report and keep building as written. **Part 2** is the
engineering log: every choice I make, with date, choice, reason, in 2–5 lines.

---

## Part 1 — Settled product decisions (brief §3, copied 2026-10-28)

Numbers in brackets are decision numbers in the Observe spec.

| Topic                  | Settled answer                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Repo                   | `harshit110927/dripmetric-v1`, branch `v2-observe`. Held only a README on 28 Oct 2026, so build fresh unless v1 code appears.                                                                                                                                                                                                                                                                                                                                      |
| Free and paid          | The table in brief §2 (the "latest plan": segment splits are free).                                                                                                                                                                                                                                                                                                                                                                                                |
| Database [1]           | Supabase Free now, plain Postgres features only, so leaving is a dump and a restore. Plus a parallel self-managed **shadow copy** (M13): dual writes through the worker, shadow reads that log differences and latency, daily reconciliation, monthly drills. Switch triggers: storage > 400 MB of 500 MB, p95 dashboard query > 1 s, or real data needing backups we control. **Gate: no real founder data until the shadow copy or Supabase Pro backups exist.** |
| Event table [3]        | The compact design (brief §4): dictionary-encoded event names, integer user keys, context stored once per session, ~215 bytes per event.                                                                                                                                                                                                                                                                                                                           |
| Retention [4]          | Free keeps 90 days of raw events, paid keeps 13 months, daily summaries kept forever.                                                                                                                                                                                                                                                                                                                                                                              |
| Alert channels [5]     | Instant masked alerts to Slack **or** Discord (founder's choice) plus an always-on in-app feed. Founders with neither get one email digest a day, only on days with alerts.                                                                                                                                                                                                                                                                                        |
| Masking [6]            | A 6-character tag from an HMAC of the user id under a per-project secret; coarse times.                                                                                                                                                                                                                                                                                                                                                                            |
| Intent score [7]       | Defaults in brief §8.2. The "didn't pay" window is a **manual per-project setting, default 14 days**. Leave `TODO(decision-7)` where the window is read. Do not build trial-aware logic.                                                                                                                                                                                                                                                                           |
| Leaks [8]              | Defaults in brief §8.3: 24-hour stalls (adaptive per step once data exists), a 2-hour checkout window, 7 days quiet.                                                                                                                                                                                                                                                                                                                                               |
| Paid event [9]         | **Required to finish setup**: `Subscription Started`, or a Stripe connection later. The dashboard works before it arrives; "intent but didn't pay" and potential revenue stay off, with a plain note, until it does.                                                                                                                                                                                                                                               |
| Event matching [10]    | Built from day one: an event dictionary, an Inbox for unmapped events, AI-suggested mappings the founder confirms. Founders map to ~a dozen fixed meanings only.                                                                                                                                                                                                                                                                                                   |
| Libraries [11]         | We build the **browser and Node libraries only**. We accept Segment's message format, so Segment's own open-source libraries (Python, Ruby, PHP, Go) work pointed at our host. Any other language uses plain HTTP.                                                                                                                                                                                                                                                 |
| No-code feeds [12]     | Adapters for Segment, RudderStack and PostHog.                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Consent [13]           | Where consent is required, the browser SDK stores nothing on the device and sends nothing — not even a config fetch — until `consent(true)`. Events wait in memory and go out only if consent arrives. Server events are unaffected.                                                                                                                                                                                                                               |
| Potential revenue [14] | Always shown, with its formula on screen.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Event catalog [16]     | Settled. Brief Appendix A is the list.                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Deferred               | Database choice at relaunch [2] and the tier-plan update [15]. Ignored.                                                                                                                                                                                                                                                                                                                                                                                            |

### Settled stack (technical design D1–D6)

- Next.js on Vercel for the founder app. The public API starts as Next.js route handlers,
  but ingest code must be framework-agnostic so it can move to its own service later.
- Supabase Postgres, plain-SQL migrations. Postgres only: no ClickHouse. A per-user
  step-state table. Partition events by month later (pg_partman), not now.
- One always-on Node worker running pg-boss on the same Postgres. Keep pg-boss behind a
  thin queue adapter so it can be swapped.
- Server-only database access. Every query scoped by project through one helper, RLS on as
  a backstop. The browser never holds a database key.
- App-level envelope encryption (AES-256-GCM) for stored secrets and end-user emails, with
  a key id stored beside each ciphertext. Not Supabase Vault, not pgsodium.
- Our own system email (login links, alert digests, reports) through Resend.
- A small, cheap Anthropic model for event-mapping suggestions. Model id in config.
- Sentry plus structured JSON logs.
- TypeScript everywhere, strict mode. Ingest hot path: plain parameterised SQL, batched
  inserts, no ORM.

### Assumptions carried from the brief (§12), flagged for the founder

Working hours Mon–Fri 09:00–18:00 local · quiet hours 22:00–08:00 · a median needs 20
activations · the `optedOut` trait · timestamps more than 24 h in the future are rejected ·
the `type` property on `Checkout Started` · the two "didn't pay" counts (past the window,
still inside it) · the weekly subject counts users who reached high intent last week and
have not paid yet.

---

## Part 2 — Engineering decisions

### 2026-10-28 · Repo state: build fresh

`harshit110927/dripmetric-v1` on `main` is a single `README.md` (45 bytes, commit
`38c6ded`). No v1 SDK, no Next.js app, no cron. Brief Step 0 says: if still empty, build
fresh. Building fresh. Nothing from v1 was reused because there is nothing there.

### 2026-10-28 · Background pages: all reachable

All six claude.ai pages in brief Appendix C resolve and are readable through the Claude
Docs connector (they are Claude Docs documents, not plain artifacts). The Observe spec
`12g68usntWGs9pvMmS2QA2` has two tabs: the spec and the Event catalog. There is **no
Projects tool** in this session, so the project-document copies (`claude/*.md`) and the
PDF prints are not reachable — but every one of them has a live page that is, so nothing
is lost. I read them on demand, not up front.

### 2026-10-28 · Toolchain versions (verified against the npm registry today)

Node 22.22.0 · pnpm 10.28.0 · Docker 29.9.2 / Compose 5.6.1 · Postgres 16.15 client.
Checked today: `pg-boss` 12.38.0 (MIT, needs Node ≥ 22.12 — we have it) · `next` 16.4.3
(MIT) · `zod` 4.6.7 (MIT) · `vitest` 5.0.5 (MIT) · `pg` 8.23.1 (MIT) · `pino` 10.4.0 (MIT)
· `eslint` 10.13.0 (MIT) · `prettier` 3.9.10 (MIT) · `@playwright/test` 1.64.1 (Apache-2.0).

### 2026-10-28 · TypeScript pinned to 6.0.3, not 7.x

`typescript@latest` is 7.0.2 (the native compiler), but `typescript-eslint@8.72.1` still
peer-requires `typescript >=4.8.4 <6.1.0`. Linting a TS 7 codebase would be unsupported.
6.0.3 is the newest version inside that range, so we get current language features and a
working lint toolchain. Revisit when typescript-eslint ships TS 7 support.

### 2026-10-28 · No `ua-parser-js`: a 120-line parser of our own

`ua-parser-js@2.0.10` is **AGPL-3.0-or-later** — confirmed against the registry, exactly as
the brief warned. It cannot ship in the web app. We need only three facts (device type,
OS, browser + major version) and we prefer the low-entropy client hints when the browser
sends them, so the user-agent string is a fallback. A small parser of our own in
`packages/ingest/src/enrich/user-agent.ts` is MIT-clean, has no supply chain, and is
testable against fixtures. `bowser` (MIT) is the fallback if ours proves too weak.

### 2026-10-28 · Postgres driver: `pg` (node-postgres), not `postgres` (porsager)

`pg` is MIT; `postgres` is Unlicense (fine, but less common in audits). More important:
pg-boss is built on `pg`, so one driver and one pool serve both. `pg` only uses prepared
statements when a query is given a `name`, and we never name one — so the same code works
through Supabase's transaction pooler (port 6543), which does not support them. No ORM
anywhere; plain parameterised SQL through the scoped helper.

### 2026-10-28 · Test runner: vitest; lint: eslint flat config + prettier

Vitest 5 runs the same TypeScript the app does with no build step, has first-class
`vi.useFakeTimers` for the time-travel tests the engines need, and one config covers unit
and integration. ESLint 10 flat config with `typescript-eslint`. Prettier for formatting,
checked in CI so no diff is ever about whitespace.

### 2026-10-28 · Migrations: plain SQL files + a 60-line runner, no migration library

Settled decision D2 says plain-SQL migrations. A library would add a dependency and its own
table format for something that is `ls`, `sort`, `BEGIN`, run, record. `packages/db/migrations/NNNN_name.sql`
run in filename order inside one transaction each, recorded in `schema_migrations`.
Migrations are forward-only; a mistake is corrected by a new migration.

### 2026-10-28 · The app connects as a non-owner role, so RLS is real

Row-level security does not apply to a table's owner, so a "deny by default" policy is
decoration if the app connects as the owner. Migration 0001 creates `dripmetric_app`
(not superuser, no BYPASSRLS), grants it DML, and every tenant table is
`ENABLE` + `FORCE ROW LEVEL SECURITY` with a policy keyed on
`current_setting('app.project_id')`. `.env` therefore carries two URLs: `DATABASE_URL`
(the app role, runtime) and `ADMIN_DATABASE_URL` (the owner, used only by
`pnpm db:migrate`). A test asserts the role is neither superuser nor BYPASSRLS, and
another asserts a raw connection with no scope set sees zero rows.

### 2026-10-28 · `withProject` opens a transaction; `withoutProject` is the only way out

`SET LOCAL` lasts only for a transaction, and the ingest pipeline has to write the
event, the session and the step state together anyway (brief section 5, step 8), so a
transaction per scope costs nothing we were not already paying. `@dripmetric/db`
exports no bare `query` and no pool, so the only way to reach tenant data is inside a
`withProject()` callback. Genuinely cross-project work (creating a project, founder
login, resolving an API key, worker sweeps) goes through `withoutProject(reason, …)`
with a reason from a fixed list — a named, reviewable escape hatch rather than an
accident.

### 2026-10-28 · Dev-only password for the app role, set by the migrate CLI

A password in a committed migration would be a credential in git. Instead migration
0001 creates the role `NOLOGIN`, and the migrate CLI grants it a login password
**only when `NODE_ENV !== 'production'`**, so a fresh clone works with the committed
`.env.example` and production sets its own password out of band (to go in
`docs/runbook.md` at M13).

### 2026-10-28 · Tests clean up with DELETE, not TRUNCATE

`TRUNCATE` takes an ACCESS EXCLUSIVE lock on every listed table at once and deadlocked
against the connection pools other test files still held. The tables hold a handful of
rows during a test, so ordered `DELETE`s cost nothing and take far weaker locks.
Vitest also runs test files sequentially (`fileParallelism: false`): they share one
local Postgres and one between-test cleanup, so two files at once delete each other's
fixtures.

### 2026-10-28 · Two catalog gaps the count test caught

Writing the Appendix A count test found two real problems, both now fixed.
(1) Eight events had a one-word job ("Risk."), which is not enough for the coverage
checklist to explain itself to a founder; each now says what the signal is for.
(2) `Checkout Abandoned` was not marked server-only. A publishable key must never be
able to inject a leak-bearing event, and Stripe's `checkout.session.expired` is its
fallback source, so it is server-only like the other 20. That makes 21 billing events,
which reconciles brief section 2 ("billing adds 21") with Appendix A section H
("Revenue: 18 events"): 18 in section H plus `Checkout Payment Declined`,
`Payment Method Added` and `Checkout Abandoned` in section G.

### 2026-10-28 · The queue's own schema, created by a migration, not by pg-boss

pg-boss keeps its tables in a schema of its own, so a dump and restore of `public`
stays clean. But creating a schema needs `CREATE` on the **database**, and that is the
one privilege the application role must not have: it would let the role build itself a
table outside every RLS policy we wrote. So migration `0003_queue_schema.sql` creates
`pgboss` as the owner, grants the app role `CREATE` on that schema alone, and the
worker starts pg-boss with `createSchema: false`.

### 2026-10-28 · pg-boss's default policy does NOT deduplicate on `singletonKey`

Verified against pg-boss 12.38.0. A `singletonKey` only collapses jobs when the queue
was **declared** with a policy that says so, and the default `standard` is not one.
`recompute-intent` and `recompute` are declared `short` (at most one job queued per
key, unlimited active), which is what ingest follow-ups want: a busy person yields one
recompute per batch instead of a pile of them, without holding back one already
running. A test asserts it, which is what caught the wrong assumption.

### 2026-10-28 · `@dripmetric/db/admin` keeps migrations out of the request path

Migrations, the schema reset and the `.env` loader all touch the filesystem and the
schema itself. Exporting them from the package's main entry point meant the Next.js
build pulled `migrate.js` into the web bundle and warned about it. They now live
behind a subpath export that only the migrate CLI, the worker and the tests import. A
route handler cannot reach a migration runner at all, which is the better arrangement
regardless of the warning.

### 2026-10-28 · Magic-link verification is a route handler, not a page

Next.js only allows a cookie to be set from a route handler or a server action, so
`/login/verify` as a page threw at runtime. It is now `route.ts`, and a failed link
redirects to `/login?problem=expired|used|unknown`, where the founder reads one plain
sentence instead of an error page.

### 2026-10-28 · Creating a project returns its keys instead of redirecting

A secret key is stored hashed and is readable exactly once (brief section 5), so it
only exists in memory during the response that creates it. Redirecting would throw it
away, and stashing it somewhere to survive the redirect would mean storing a secret
key in the clear — the thing the hashing avoids. So `createProjectAction` returns the
four keys and the form renders them, with the warning that this is the only time the
two secret keys can be shown.

### 2026-10-28 · Measured storage: 245 bytes per event, inside the ±20% band

200,000 events on a clean table: **245.0 B/event** total — heap 124.3, indexes 120.7
(`events_pkey` 50.3, user-and-time 39.3, name-and-time 30.8, the BRIN 0.1). Target 215
±20% = 172–258.

Two things had to be got right for the number to mean anything:

1. **Dead tuples.** The first measurement said 398 B/event partly because earlier
   tests had deleted rows from the same table and `pg_table_size` counts the dead
   space. The test now runs `VACUUM FULL` before it measures.
2. **Arrival order.** Index size on random keys depends almost entirely on btree page
   fill, which depends on insert order. Interleaving all 2,000 users in strict
   rotation measures **398 B/event**; generating sessions — one person firing a burst
   of events, sessions following each other in time, which is how traffic actually
   arrives — measures **245**. The realistic order is the one the test asserts, and
   the adversarial figure is recorded here so the sensitivity is on the record rather
   than hidden inside a passing test.

The design choices that buy it: dictionary-encoded event names (4 bytes, not a
string), 4-byte integer user keys, context stored once per session, `message_hash` as
a `uuid` (16 bytes, no varlena header) rather than the client's text id, and a BRIN
index for the retention job's range deletes, which costs 0.1 B/event where a btree
would cost ~30.

### 2026-10-28 · Throughput: batched inserts took 1,000 events from 202 to 803/second

The first pipeline ran about a dozen serial queries per event — identity, session,
name, path, daily cap, event, four queries of step matching, tracked-user row — and a
1,000-event batch took 4.9 seconds, which would time out a serverless function.

Brief section 3 says the hot path uses batched inserts, so the pipeline is now two
phases. **Prepare**, per message, resolves everything through per-batch caches, so
1,000 events from 100 people cost 100 user lookups rather than 1,000, and step
matching became a pure in-memory function over a funnel loaded once. **Flush**, once
per batch, does one multi-row insert each for the events, the step state, the
tracked-user rows and the daily counters; the insert's `RETURNING` clause says which
rows actually landed, so a duplicate is a fact rather than a guess.

Result: **803 events/second**, 1,000 events in 1.25 s. The next lever, if it is ever
needed, is batching the identity resolution itself (one query for all the distinct
user ids in a batch instead of one each).

### 2026-10-28 · Three bugs the exit-check tests caught

Worth recording because each was a silent wrong answer, not a crash.

1. **The daily cap stored one row too many.** `stored_count <= cap` is true on the
   first overflow row too, because `stored_count` has already stopped climbing by
   then. The table now keeps a `total_count` of everything that arrived and derives
   the other two from it, so "was this row stored?" is one exact comparison.
2. **The daily counters undercounted the overflow.** They were built from the rows
   that got written, so the events the cap rejected were never counted — the cap would
   have reopened on the next batch and tracking health would never have seen the
   overflow. They are now built from what arrived.
3. **An empty batch returned 200 before authenticating.** The shortcut sat above the
   key check, so an unauthenticated request could learn that its body was well formed.
   Authentication now comes first, whatever the batch holds.

### 2026-10-28 · Dev conveniences, gated on there being no email provider

`/dev/mailbox`, `/dev/login` and `/dev/project` exist so the whole flow — email to
keys to first event to dashboard — can be walked by a script without driving a
browser, which is how the M0 exit checks are shown to be true. All three are gated on
`RESEND_API_KEY` being unset, so they cannot exist in production, where it is set.

### 2026-10-28 · `pnpm licenses` and `pnpm ci` were shadowed by pnpm built-ins

CI failed on the licence step with `ERR_PNPM_LICENCES_NO_SUBCOMMAND`. The cause: `pnpm
licenses` is a **pnpm built-in command**, and a built-in always wins over a package
script of the same name, silently. So that CI step ran pnpm's own `licenses` command,
which needs a subcommand, and the licence check never ran at all. `pnpm ci` was
shadowed too (`ERR_PNPM_CI_NOT_IMPLEMENTED`), so the command documented in CLAUDE.md
and the README had never worked either.

Renamed to `check:licenses` and `verify`. A colon cannot appear in a pnpm command, so
colon-prefixed script names can never collide — that is now the convention.

`scripts/check-script-names.mjs` makes it impossible to repeat: it parses the command
list out of `pnpm help -a` and fails if any script name collides with one, allowing
only `test` and `start`, which pnpm implements by running the script of that name. It
runs as the first step of `pnpm verify` and as its own CI step. Proven in both
directions: re-adding a `licenses` script makes it exit 1 and name the offender.

**The process lesson, now rule 4 in CLAUDE.md:** I had reported "CI green" after
running the moving parts by hand (`node scripts/check-licenses.mjs`, `npx vitest`,
`npx eslint`) without ever running `pnpm verify` or `pnpm licenses` themselves. Those
are the commands CI runs and the ones a founder would type, so they are the ones that
have to be run. `pnpm verify` and every individual CI step are now confirmed green.

---

## M2 — Simulator

### 2026-10-28 · The simulator records truth as it generates, not afterwards

`packages/sim` plays synthetic people through three dummy products and writes down
what will happen to each one **at the moment the decision is made**, not by inferring
it from the events later. That is the whole difference between a simulator you can
score an engine against and a pile of plausible-looking data: "what share of stalled
users did leak detection catch?" is only answerable because something independent
recorded that the stall was deliberate.

Deterministic by seed (mulberry32, no `Math.random` anywhere) and on a virtual clock,
so a 30-day journey generates in milliseconds and a 49-hour stall is a number rather
than a wait. A person's stream is seeded from the run seed **and their index**, so
adding users does not reshuffle the ones already there — otherwise growing a run would
invalidate every number measured from a smaller one.

Seven personas: the brief's four (converter, staller, intent-then-leaves,
payer-gone-quiet) plus a tourist on a disposable address, a crawler and the founder's
own team. The last three exist to prove the filters work rather than to be measured.

### 2026-10-28 · The products send the founder's OWN event names

Ledgerly sends `Invoice Sent`, Loomwork sends `Board Created`, Hookrelay sends
`Webhook Delivered` — never `Core Action`. A test asserts the canonical name is
_absent_. A product whose names were already canonical would never exercise the event
dictionary or the Inbox, which is the thing most likely to be subtly wrong
(brief section 7).

### 2026-10-28 · Four real bugs the simulator found in M1's pipeline

This is the return on building it, so each is recorded with what it would have cost.

1. **Within-batch duplicates reported `ok` twice for one stored row.** Postgres's
   `ON CONFLICT DO NOTHING` inserts the first of two identical keys in a statement
   and skips the second silently, so `RETURNING` listed the hash once while both
   pending rows matched it. The stored count was right; the per-message result lied,
   and a client retrying inside one batch would never learn its retry was collapsed.
   M1's exit check missed it because it replayed a batch as a _second request_.

2. **The request user-agent beat the per-message one, so no crawler was ever
   dropped.** `isBot(project.userAgent ?? message.context?.userAgent)` — and Node's
   fetch sends `user-agent: node`, which is non-null, so the message's own context
   was never consulted. This was not a simulator artefact: every server-side batch,
   and every Segment, RudderStack or PostHog feed, carries one HTTP user-agent (the
   forwarding server's) and a per-message context describing the real visitor. In a
   300-person run, not one of the 12 crawlers was filtered. The precedence is now
   stated once, in `visitorUserAgent`, and both call sites use it.

3. **Internal users kept events that arrived before their `identify`.** A step event
   and the identify shared a millisecond and the messageId tiebreak put the event
   first, so it was stored before we knew the address was the founder's own.
   `markInternal` now deletes what is already stored — events, step state, daily
   counters, tracked-user rows — and drops rows queued earlier in the same batch.
   "The founder's own team is out of every number" is now true rather than nearly
   true, instead of relying on every future query remembering to filter on
   `internal`.

4. **Only the dozen mappable meanings were recognised as canonical.** So
   `Onboarding Step Viewed`, `Email Verified` and `Trial Started` all landed in the
   Inbox as unmapped, and step **entry** was lost for every step without a URL rule.
   The score showed 67 of 126 known stalls. The dozen meanings are what a founder may
   map their _own_ names onto; they were never meant to limit what we recognise when
   a catalog name is sent verbatim ("named right at the source", brief section 7).
   Checking the whole catalog took it to 126 of 126.

A fifth was a crash rather than a silent wrong answer: `applyStepUpdates` sent one
multi-row `INSERT … ON CONFLICT DO UPDATE` whose own rows collided, which Postgres
refuses outright ("cannot affect row a second time"). A batch routinely carries two
updates for one person and step, because entering a step and completing it are two
events — 1,065 of 6,458 messages failed with a 500 the moment a funnel existed to
match against. `mergeStepUpdates` now collapses a batch to one row per (person, step)
with the same semantics the SQL had.

### 2026-10-28 · The simulator configures the funnel, because otherwise nothing is visible

`configureProject` applies the funnel, URL rules and the core-action mapping a founder
confirms at setup. Step state only exists for steps that are declared, so a run
against an unconfigured project records no stall at all — the score read 0 of 126
until this existed. The real setup flow is M5; this is the same data applied directly,
so M6 to M8 can be verified before that flow exists.

### 2026-10-28 · Scoring runs in CI, not just in the CLI

All three products score 100% on filtered / tracked / paid / stalls-visible /
intent-signals-present, and still do with duplicates, late events and clock skew
injected together — a fault is a tracking problem, not a user problem, so it must not
cost a single known person. The per-engine shares the brief asks for ("what share of
stalled users did leak detection catch") need the engines themselves and arrive with
M7 and M8; what is scored now is whether ingest put the right people and events in
the database at all, which is the floor those later scores stand on.

### 2026-10-28 · `visits` counts distinct sessions within a batch only

Counting a step's visits across batches needs the session recorded per
(person, step), which is M6's job. Until then the merge counts distinct sessions in
the batch, so a visitor returning in a later batch is **under**counted rather than
over-counted. Noted because an undercount is the safer direction but still wrong.

---

## M3 — Browser SDK

### 2026-10-28 · The SDK does not import the catalog; a test keeps it honest

The catalog carries Zod schemas and 76 event definitions. Importing it into a bundle
with a 5 KB gzipped budget is not possible, so the twelve names the SDK sends are
string literals in `packages/sdk/src/shared/types.ts`. That trade needs a guard: a
typo in one of those literals would reach a founder's dashboard as an event that can
never be mapped, sitting in their Inbox forever looking like one of their own. So the
catalog is a **devDependency** of the SDK, used by one test that reads those literals
out of the source and asserts each is a real catalog name. `files: ["dist"]` keeps it
out of the tarball; `npm pack --dry-run` confirms 25 files, all `dist`, README,
LICENSE and package.json.

### 2026-10-28 · `PAGE_LEFT` is its own constant, because objects do not tree-shake

esbuild cannot tree-shake an object's properties, so importing `AUTO_EVENTS` for the
one name the core sends pulled all twelve strings into the bundle. The core now
imports `PAGE_LEFT` on its own and the object stays for the lazy chunk. Worth ~90
bytes gzipped, which mattered.

### 2026-10-28 · The lazy chunk is its own entry point, not an esbuild split chunk

`splitting: true` hoisted the shared constants into a chunk that `index.js` imports
**statically**, so the core actually cost `index.js` plus that chunk — 5,422 B against
a 5,120 B budget — while the size report measured only `index.js` at 5,009 and passed.
The budget was being enforced against a number that was not the download size.

The lazy module is now marked external in the core build and built as its own
self-contained entry. It duplicates a few hundred bytes of constants and makes the
core exactly what a browser downloads for `import 'dripmetric/browser'`. The build
also refuses to measure a core that contains any static import, so this cannot come
back quietly.

Final: **core 5,018 B gzipped** (budget 5,120), lazy chunk 1,556 B, script-tag build
6,488 B, server 1,091 B.

### 2026-10-28 · Slow Page moved to the lazy chunk, where the brief had it all along

Reporting load speed from the core was wrong twice over: brief Appendix A makes
Slow Page a **key-pages-only** event alongside forms and clicks, and putting the
Performance API in the core is what pushed the bundle 33 bytes over budget. The
budget check is what surfaced the misreading.

### 2026-10-28 · A stale `.tsbuildinfo` silently skipped the declaration emit

`tsc -p tsconfig.build.json` printed nothing, emitted nothing and exited 0. The
incremental build info outlived `rm -rf dist`, so tsc believed its output was current
— and the package would have shipped with `exports.types` pointing at files that did
not exist. A declaration-only emit takes under a second, so `incremental` is off.

### 2026-10-28 · Interaction capture retries when settings arrive

Playwright found this one. Settings (which pages are key pages) are fetched
asynchronously, and `init()` sends the first page view immediately, so `isKeyPage()`
was always false the first time it was asked. On the landing page — often the only
page in a session — forms, clicks and speed capture never started at all. The settings
response now re-attempts the load.

### 2026-10-28 · The transport will not start a second send while one is in flight

A retry loop runs for seconds, and the 2-second flush timer fired inside it and queued
another attempt behind the first. Wasted work, and the cause of a flaky test. There is
now a `sending` guard, and `schedule()` does not set a timer while a send is running.

### 2026-10-28 · The retry tests use fake timers

Even with that guard the retry test stayed flaky: it counts attempts, and the backoff
is real time (500 ms then 1 s, both jittered) racing a real 2-second timer. It saw
three requests alone and four in the suite. `vi.useFakeTimers()` plus
`runAllTimersAsync()` removes the race and takes seconds off the suite. Transports made
by a test are also disposed in `afterEach`, because `fetch` is resolved at call time:
a stale transport's retry loop lands on the _current_ test's mock.

### 2026-10-28 · The id fallback does not build a real UUID

`crypto.randomUUID` needs a secure context, so a founder testing on plain http does
not get it. The fallback only has to be unique — the server dedupes on the id and
never parses it — so hand-building a v4 UUID from `getRandomValues` was ~200 bytes of
a 5 KB budget spent on a shape nothing reads.

---

## M4 — Server SDK

### 2026-10-28 · One `flushAfterResponse` helper serves Vercel and Next

Verified today rather than recalled, because the brief flags these names as moving:
`@vercel/functions` 3.10.4 exports `waitUntil: (promise: Promise<unknown>) => void`,
and Next.js 16.4.3 exports `after<T>(task: Promise<T> | (() => T | Promise<T>))` from
`next/server`. **Both accept a promise**, so one helper works for either:
`flushAfterResponse(dm, waitUntil)` or `flushAfterResponse(dm, after)`.

Neither package is a dependency. The founder already has whichever they use, and a
zero-dependency library should not reach for either — a dynamic import of an optional
peer is exactly the kind of thing that breaks in someone else's bundler. With no
scheduler the flush is left running, which is correct on a long-running server, and a
scheduler that throws (both platforms reject a call outside a request scope) is
caught, because the flush is already in flight and nothing is lost.

### 2026-10-28 · `deleteUser` awaits, unlike every other call

Every other method returns immediately — that is the point of the queue. A deletion
request is different: the caller needs an answer they can act on, usually because
someone asked them to erase a person. It returns `{ deleted }`, treats an unknown user
as already gone (404 → `deleted: false`) so a retry is safe, and throws on anything
else.

The endpoint was built here rather than waiting for M11, because an SDK method that
404s is worse than no method. It deletes events, step state, counters, tracked-user
rows, anonymous links, account memberships, sessions and the person, children before
parents, and writes an audit row. **Daily summaries are deliberately untouched**: they
hold counts, not personal data, and deleting them would silently rewrite the founder's
own history. M11 adds the audit-log view and the retention job around it.

### 2026-10-28 · A publishable key is refused by the constructor

`new Dripmetric({ secretKey: 'pk_…' })` throws immediately. With a publishable key
every server-only trait and billing event would be refused one at a time,
server-side, with no obvious cause — a slow mystery instead of a fast error.
`signUserId` refuses one too, for a sharper reason: a publishable key is public, so
anyone could forge the signature and identity verification would be theatre.

### 2026-10-28 · Fake timers do not mix with a real HTTP server

The browser transport's retry test uses fake timers and is deterministic. The
server's equivalent could not: `vi.runAllTimersAsync()` decides there are no timers
left while a real round trip is still in flight, so the next backoff is never queued
and the loop ends an attempt early — two requests where three were due. That test
uses real time (250 ms then 500 ms, about a second total) and is honest about it.

### 2026-10-28 · The example app is the exit check, not a demo

`examples/next-app` sends `Signed Up`, `Activated` and `Checkout Started` from server
routes with `flushAfterResponse(dm, after)`, and identifies from the browser. Run
against a live local API with a real secret key, all three arrive with
`source = server`, their canonical names mapped, and the email stored encrypted with
type `work`. It also shows the two things easiest to get wrong: one module-level
client (a per-request instance would hold a queue discarded before it ever flushes),
and `init` inside an effect so it only ever runs in the browser.

### 2026-10-28 · CI needed a Playwright browser; the dev container had one for free

The e2e tests passed locally and failed on every GitHub runner with "Executable
doesn't exist at ~/.cache/ms-playwright/…". The dev container ships Chromium and
points Playwright at it with `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers` and
`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`. A CI runner has neither, so Playwright looks in
its default cache and finds nothing.

CI now caches `~/.cache/ms-playwright` and runs
`playwright install --with-deps chromium` before the e2e step. Chromium only — it is
all `playwright.config.ts` launches. The cache key is the lockfile hash, so bumping
Playwright invalidates it on its own rather than silently reusing a browser the new
version cannot drive.

**The lesson, which is not about Playwright:** I had written the config around a
convenience of _this_ container and never asked whether the runner shared it. Anything
the dev environment provides for free — a pre-installed browser, a running Docker
daemon, a populated `.env` — is a thing CI has to be told about explicitly. I cannot
verify this particular fix locally either, because installing a second browser here
would not be found by the pinned Playwright, so the CI run is the proof.

---

## M5 — Product model and event matching

### 2026-10-28 · The scrubber checks patterns before length, and keys before both

Three rules, in this order, each catching what the others cannot:

1. **The property KEY.** `"name": "Pat"` matches no pattern — three letters, no digits,
   no `@` — and is still somebody's name. Only the key gives it away.
2. **The VALUE's shape.** A founder who puts an email in a `plan` property gets no
   help from the key, so the patterns have to catch it.
3. **Length and cardinality.** A sample is only useful when it is short and the
   property has few distinct values: a plan name, a step label, a method. Anything
   else is free text or an id.

The patterns run _before_ the length limit, which does not change whether a value is
dropped but does change the reason reported — and "looks like email" is a far better
line in a log than "longer than 24 characters". It also keeps the patterns
load-bearing if the length cap is ever raised. They are ordered most-specific first
for the same reason: the loose `phone` shape otherwise claims card numbers and IP
addresses, both of which it technically matches.

`prefixed-id` takes an optional second segment (`[a-z]{2,8}(?:_[a-z]{2,8})?_…`),
because `sk_live_…` and `pk_test_…` are the shapes most worth catching and a
single-underscore pattern misses them — `\b` fails before `live_…` since the
preceding `_` is a word character, so only the generic token rule caught them.

There is deliberately no path that _transforms_ a value into a safe version. A
partially redacted email is still an email leaving the building.

### 2026-10-28 · The model is reached through an injected function, not an SDK

`suggestMappings(input, ask)` takes a one-call `ask` function. Tests mock it without
touching the network (CLAUDE.md rule 3), `packages/engine` stays pure and
dependency-free, and changing model is config rather than code. The reply is
schema-validated with one retry, and the retry says _what was wrong_ with the first
answer — a model given the specific problem usually fixes it, while one given the same
prompt usually repeats itself.

Three things the validator refuses outright, because each would silently move a
founder's numbers with no way for them to tell: a meaning that is not on the closed
list, a `raw_name` we never sent, and a second name claiming a meaning already taken.
`canonical: null` is accepted as a real answer — a wrong mapping is worse than none.

A failure is recorded, never thrown: brief §7 says the Inbox still works by hand.

### 2026-10-28 · Two serious bugs, found by one failing test

A test asserting that unmapping a name removes its step state failed, and tracing it
turned up two separate faults.

**1. A recompute run was never marked done, so later mapping changes silently did
nothing.** The run only reached `done` when a chunk came back with _zero_ events, so a
rebuild that fitted in one chunk left it `running` for ever. And because
`queueRecompute` joins an existing run rather than starting a second, every later
mapping change was swallowed: the founder changes a mapping, sees no change, and has
no way to find out why. A short chunk is now the last chunk and finishes the run.

This is the worst class of bug this product can have — a number that quietly stops
updating — and it would not have shown up in any single-change test.

**2. `event_count` counted batches, not events.** It was incremented inside
`resolveNameId`, which caches per batch, so six events with one name counted once. The
founder reads that number in the Inbox ("sent 1 time" for something sent 10,000
times), and the AI prompt uses it to pick the top 60 names by volume — so an
undercount is a wrong screen _and_ a wrong prompt. Counting now happens per
occurrence and flushes in one statement per batch, like the daily counters.

### 2026-10-28 · Recompute clears derived state on its first chunk

The step-state merge is order-insensitive, so replaying events over existing rows
would be safe — but it can only add and update, never remove. A step whose event name
changed, or one deleted from the funnel, would otherwise keep its old state for ever
and the founder would see a stage that no longer exists. So the first chunk deletes,
then rebuilds.

### 2026-10-28 · Recompute and ingest share the same `matchSteps`

Recompute reads the same pure function, over the same funnel, as the live pipeline.
Two implementations of "which step does this event touch" would eventually disagree,
and the disagreement would look like a data bug rather than a code bug. The
equivalence test is what holds it: recomputing after a mapping change gives
byte-identical step state to ingesting the same events with the final mapping from the
start.

### 2026-10-28 · A test fixture must not have a real key's shape

GitHub's push protection blocked a push: `sk_live_` followed by 24 alphanumerics in a
scrubber test — exactly Stripe's shape. The string was invented, and that is beside
the point. Neither a secret scanner nor the next person reading the file can tell an
invented key from a leaked one, so it does not belong in the repo at all.

Fixed by using a non-vendor prefix (`key_live_EXAMPLEONLYNOTREAL`), which exercises
the identical regex branch and could not be mistaken for anything live. The
`sk_test_abcdefghijklmnop` fixtures in the SDK tests stay: they have to carry a real
prefix, because what they check is that the constructor REJECTS a publishable key,
and a 16-character body is nowhere near a real key's length.

`scripts/check-fixtures.mjs` now runs in `pnpm verify` and in CI. Push protection
already catches this, but only at push time, after a commit has been made and has to
be amended. This catches it seconds after it is written. The rule is about shape, not
liveness, and the thresholds are deliberately above placeholder length so the
legitimate fixtures pass.

### 2026-10-29 · Dictionary facts are a job, not part of the ingest hot path

The property keys, shape-only samples and sequence positions the AI prompt needs are
built by `refreshDictionaryFacts`, which scans a bounded sample on demand, rather than
being accumulated on every event.

Three reasons, in order of weight. The scrubber runs once per property, where it can
be tested, instead of once per event on the hot path. Sequence position needs a
person's whole history, which a single event cannot know. And it is re-runnable: when
the scrubber improves, the stored samples can be rebuilt — impossible if values had
been scrubbed on the way in and the originals thrown away.

The sampling is bounded per name by a lateral join (200 events each, on
`events_project_name_time_idx`), not by a global `LIMIT`. A global limit would have
sampled only the busiest names and left the rare ones — the ones most likely to be
sitting unmapped in the Inbox — with no properties at all. The reach
(`distinct_users`) is counted exactly over every event, because the founder reads that
number; only the median position is taken from a sample of whole sequences.

### 2026-10-29 · The withheld-data audit record comes from the first scrub gate

There are two scrub gates: one when the facts are stored, one when the prompt is
built. A test found that `runSuggestions` was recording the SECOND one's `dropped`
list in the audit row — which is empty by construction, because the first gate had
already replaced every unsafe sample with null.

So the one thing we most want logged — what personal data we refused to send to a
model — would have logged an empty list for every real project. The row now records
both: `withheld` from the first gate, and `droppedAtPrompt` from the second, which
should always be empty. If it ever is not, a sample that was stored as safe was not,
and that is worth finding in the log rather than inferring later.

### 2026-10-29 · No "failed payments" on the coverage checklist

A coverage requirement named `Payment Failed`, which carries no checklist priority
because Appendix A says it arrives "after at least one payment" — it is churn, not a
leak between a first visit and a first payment. The metric could therefore never have
turned on, whatever the founder sent, and the screen would have told them to send an
event that would not have helped.

The requirement was wrong, not the catalog: recovery is a later layer. The test now
asserts that every required event is ON the checklist, not merely in the catalog,
which is what caught it.

### 2026-10-29 · `packages/ingest` is where db and engine meet

`runSuggestions` composes three things: the facts (db), the rules and the prompt
(engine), and the model (an injected function). Something has to know all three.

It is not `packages/db` (the data layer must not depend on the engine), not
`packages/engine` (pure, no I/O), and not `apps/web` (then the worker could not call
it, and it could not be tested with the existing integration helpers). So it lives in
`packages/ingest`, next to `recompute.ts` and `dictionary-facts.ts`: the dictionary
and derived-state jobs, in the one package allowed to use both. A fourth package for
three files was not worth it. `CLAUDE.md`'s repo map now says so.

### 2026-10-29 · The web app queues a recompute by writing a row

`queueRecompute` inserts into `recompute_runs`; a worker sweep every minute finds
pending runs and fans them out onto the `recompute` queue. The request path therefore
has no queue client at all.

That keeps pg-boss out of the Next.js bundle, and — the real reason — off Supabase's
transaction pooler, which supports neither advisory locks nor `LISTEN`/`NOTIFY`. One
job drains at most 20 chunks (100,000 events) and then re-queues, so a project with
13 months of history cannot hold the queue while another founder's mapping change
waits. A run is resumable, so stopping early costs nothing.

### 2026-10-29 · The model call: SDK, no temperature, no thinking parameter

`@anthropic-ai/sdk` 1.3.0 (Apache-2.0, passes `check:licenses`), in exactly one file,
behind the engine's injected `ask`. Three things verified against that version rather
than remembered, each of which would have been a 400 or a silent wrong result:

- `temperature`, `top_p` and `top_k` are rejected on every model from API version
  2026-10-21, so none is sent.
- Haiku 5.5 has adaptive thinking on by default and rejects a thinking budget, so the
  `thinking` parameter is not sent either; depth is `output_config.effort`, set to
  `low` because mapping is a classification over short facts.
- A reply can stop with `stop_reason: "refusal"` at HTTP 200. Reading `content`
  without checking first would parse an empty reply and report it as a model that
  answered badly.

The model id stays in config (`ANTHROPIC_MODEL`, default `claude-haiku-5-5`:
$0.10/$0.50 per million tokens, so a 4,000-in/1,000-out run costs about $0.0009).
Without `ANTHROPIC_API_KEY` the button is not shown and the Inbox works by hand,
which it has to anyway. Tests use an injected mock and never reach the network.

### 2026-10-29 · Setup completion is one condition, not two rules

Settled decision 9 requires the paid event to finish setup. Rather than a separate
check, the paid event is simply one of the five facts, and setup completes when all
five are confirmed — a single SQL condition. Two rules that meant the same thing
would eventually stop meaning the same thing.

`confirmFact` refuses a fact that is not ready and says why in the founder's words.
Confirming "which event means someone has paid" when no such event exists would
record a decision about nothing, and every screen would then claim a fact it does not
have.

### 2026-10-29 · `visits` is recounted from a set, not accumulated

Every other column in `user_step_state` accumulates, which is what makes a replay safe
for them: the sum of the same events, the earliest of the same times. A count of
distinct sessions cannot work that way — adding this batch's count to the stored one
counts a returning visitor's session twice the moment two batches mention it, and the
old code could only ever see one batch, so it undercounted every returning user.

`user_step_sessions` holds one row per (person, step, session) and `visits` is set
from a count of it. A set is idempotent, so the same property is reached from the
other direction. The table earns its keep twice: the segment splits now attribute a
step to the session the person was actually in, so someone who starts a step on a
phone and finishes on a laptop is counted where they were — which is the exact case
the splits exist to find.

A step touched only by server events records no sessions and reports `visits` 0. That
is honest: we know the person did something and not which visit it belonged to.
Inventing a visit would put one on a timeline that never happened, and the browser and
server share is what tracking health reports (M11).

### 2026-10-29 · "Reached a step" is not "entered at a known time"

A step defined by a canonical event — `Signed Up`, `Activated` — has no entry event of
its own. The only thing that arrives is the completion, so `first_entered_at` is null
while `first_completed_at` is set.

Filtering a step's population on `first_entered_at` therefore read 0 people entered
against 166 completions, and the drop-off came out negative. `StepTiming.reached` is
now the population test and `enteredAt` stays what it says it is.

The consequence is deliberate and visible: such a step shows a drop-off and no
duration. `elapsedSeconds` is null, so no median, and the screen says why. Setting the
entry time to the completion time would have produced a median of zero seconds for
every server-tracked step — a number that looks like data and is not. Telling the
founder to send `Signup Started` is the coverage checklist's job, and it is on the
checklist for exactly this reason.

### 2026-10-29 · A clock read in SQL is still a hidden clock read

The 8-week trend filtered on `current_date`. Everything around it took `now` as a
parameter, and the query quietly did not.

It made the trend impossible to test over simulated data, which happens months in the
past, and it would have answered a question about last August with the last eight
weeks of this month. Both reads now take `now`, and an ESLint rule over the funnel
jobs and reads rejects `current_date`, `current_timestamp` and `now()` inside a query
there. The rule was verified by adding a `current_date` and watching lint fail.

### 2026-10-29 · The no-clock rule bans reading the clock, not the Date type

The engine lint rule started as a blanket ban on the `Date` global. That only looked
right while no engine constructed a date: `new Date(iso)` and `Date.UTC(y, m, d)` are
pure functions of their arguments, and the cohort rules need both to work out which
week a signup falls in.

The three ways to actually read a clock — `Date.now()`, `new Date()` with no
arguments, and `performance` — are banned by name instead. A rule that forbids
deterministic arithmetic pushes correct code into epoch-millisecond contortions and
teaches people to reach for the escape hatch, which is worse than the rule is good.

### 2026-10-29 · Thresholds freeze on the change, and freeze for every step

Brief §8.1: "thresholds freeze when the founder marks a change, so a before-and-after
comparison is not measured against a moving bar."

Two choices inside that. The frozen copy lives on the `changes` row rather than on the
step, because the step's live thresholds have to go on moving — the copy is the record
of what the bar was. And marking a change freezes EVERY step, not just the changed
one: a founder who shortens step 2 wants to know what it did to the whole funnel, and
the steps after it are where the answer shows up. Freezing one step would leave every
other step's "after" measured against a bar that moved underneath it.

`applyFreeze` replaces a step's thresholds outright rather than merging. A half-frozen
set — this percentile from before the change, that one from after — would answer "did
my change help?" with a number that means neither.

### 2026-10-29 · One highlighted step, not several

Brief §8.1 ends "say which, in plain words". That only works if there is one answer: a
funnel with four highlighted steps tells a founder to look everywhere, which is the
same as telling them nothing. The report picks one — hardest first, then the clearest
"they are not seeing the value", then slowest — and the rest keep their evidence
without the highlight.

The comparison behind "slow users drop three times as often" needs ten people on each
side before it is drawn at all. Below that the ratio swings on one person, and "this
step is three times harder for slow users" would be noise with a sentence attached.

### 2026-10-29 · The funnel report is computed live; the history is stored

"Users stuck now" is a present tense. A stored count would be as old as the last job
ran, and a founder refreshing the page would see a number that does not move.

So `currentFunnelReport` computes from current state on every read, bounded by the
plan's tracked-user limit and cached for 60 seconds by the dashboard (brief §9). What
IS stored is what is genuinely historical: the hourly and daily aggregates, the
segment splits, the cohorts, and the daily summary — which is the row that outlives
the raw events, since free keeps 90 days and the summaries are kept forever.

The daily summary is one JSONB payload merged with `||` rather than replaced, so M7
and M8 add their own sections to the same row without a migration each.

### 2026-10-29 · The percentile definition is shared with Postgres on purpose

The engine's `percentile()` interpolates linearly, which is exactly what
`percentile_cont` does, and the daily aggregate computes the same numbers in SQL. Two
definitions — nearest-rank in one place, interpolated in the other — would disagree by
a few seconds on the same data, and the disagreement would look like a data bug rather
than like two definitions.

The 20-completion bar is passed into that SQL as a parameter from the engine's
`MIN_COMPLETIONS_FOR_PERCENTILES`, so a stored row can never hand a screen a median
the engine would have refused to show.

### 2026-10-29 · A test timestamp in the future is not a timestamp

The M5 sequence-position test set fixed ISO timestamps an hour ahead of when the test
actually ran. The skew correction clamped all three to the arrival time — correct
behaviour, it is what stops a device with a wrong clock scattering a person's events
across the calendar — so every event shared one `occurred_at` and the sequence order
fell to the random `message_hash`. The test passed or failed depending on the hash,
and it had been passing.

It was found by M6's funnel work, which cares about ordering. Fixtures that need an
order now derive their timestamps from the real clock going backwards, and the comment
says why. A fixed timestamp in a test is only safe if it is in the past of every future
run, which a date typed today is not.

### 2026-10-29 · Signals stored as evidence with no points yet

Brief §8.2: "Signals in Appendix A that have no value in this table … are stored as
evidence and add 0 points until calibration. Do not invent points; list them in
`docs/decisions.md`." The list, as required:

`Plan Selected`, `Evaluation Page Viewed`, `Trial Extension Requested`,
`Upgrade Prompt Clicked`, `Plan Limit Approached`, `Trial Started`, `Signed In`,
`Data Exported`, and the computed signals the catalog itself marks as not needed yet
(`day1Return`, `breadth`, `depthAgainstPayers`, `devicesUsed`, `channelQuality`,
`ownerQuietTeamActive`).

They are stored and visible on a timeline, and they carry zero points. The same list
is in `ZERO_POINT_EVIDENCE` in `packages/engine/src/intent/points.ts`, so a reader of
the code can see the omission is deliberate rather than an oversight.

One of them is used without being scored: `Plan Selected` is read as the "plan click"
input to the pricing-deliberation rule. That is not points of its own — the +10 is the
`pricingDeliberation` row of the table — it is evidence feeding a rule the brief
already defines.

### 2026-10-29 · Brand search is an approximation, and here is exactly which one

Brief §8.2 asks for this to be said in the docs, so: we cannot see that someone
searched for the product by name. Search engines send a referrer without the query,
and that is not going to change.

Two observable things stand in for it, both in the `reviewOrBrandSearch` fit point:

- the founder's own `brandTerms` matched against `utm_term`, which works only for
  traffic the founder tagged themselves;
- the referrer's registrable domain matched against a list of review and comparison
  sites (`REVIEW_SITE_DOMAINS` in `packages/catalog`: G2, Capterra, GetApp,
  TrustRadius, AlternativeTo and similar), which is the same intent arriving by a
  different road.

It is +5, capped with the other fit points at +10 in total, so an approximation can
never carry a score on its own.

### 2026-10-29 · A `page` message's name was ignored, since M1

The browser SDK sends a page LEAVE as `{type: 'page', name: 'Page Left'}` with the
running totals attached (brief §6). Ingest read `message.event` for a track and used
the literal `'Page Viewed'` for everything else, so the name was dropped.

Three consequences, all shipped from M1 until M7 found them:

- No `Page Left` was ever stored from the SDK. Step timing's active seconds and the
  pricing attention time were therefore unreachable, and M6's `updatePageLeftTotals`
  was dead code in practice — a page leave's `messageId` is deterministic
  (`pl-<pageViewId>`) precisely so a re-send can raise the totals, and instead it was
  dropped as a duplicate.
- Every page view was counted twice: once for the view, once for the leave.
- The intent engine's pricing signals could not fire at all, which is how it surfaced:
  `pricingDeliberation` was true for 0 of 281 simulated users, in a run where a third
  of them deliberate on pricing for 40 to 200 seconds.

Fixed by treating a page message's `name` as an event name when it is one of ours.
Segment's `page` call uses `name` for the PAGE's name ("Pricing"), not an event name,
so only a name in our own catalog is read that way — a Segment page named "Pricing"
stays a `Page Viewed` (settled decision 11). Three regression tests cover it, and two
of them were confirmed to fail against the old line.

### 2026-10-29 · The pricing +10 is a test on the time, not on the pattern

`pricingViewed` was computed as "the view was not a quick exit and not a slow page",
which quietly gave the +10 to a `re-checking` view — and brief §8.2 defines that as "a
view under 10 seconds by someone who has seen pricing before". A two-second glance by
a returning visitor scored the same as someone who read the page.

It is now the rule as written: active time at or above the attention bar, which is ten
seconds until the product has 50 pricing views and its own 25th percentile after that.

### 2026-10-29 · The peak is replayed from events, not accumulated

The brief says the peak is "updated whenever an event is ingested". It is instead
replayed from when each signal first became true, and the incremental `updatePeak`
that existed for an afternoon was deleted rather than kept beside it.

Two reasons. A stored peak that could only be maintained forward would be lost the
first time a mapping changed, and derived state has to be rebuildable (CLAUDE.md rule
10). And `first_high_at` has to be a fact about the past: it is the clock "intent but
didn't pay" counts from, and the calibration asks whether someone crossed 60 _before_
they paid — a timestamp stamped whenever a refresh happened to run cannot answer
that, and on a first run over months of history it would stamp everyone with today.

`activeThreeOfSeven` is deliberately left out of the replay. It is a statement about
the present, so including it would make the date someone crossed 60 last March depend
on whether they logged in this week.

Keeping both implementations would have been the drift risk this codebase has already
been bitten by twice (ingest against recompute, the engine against SQL percentiles).

### 2026-10-29 · The peak is written, not raised with GREATEST

`GREATEST(stored, new)` looks safer and is worse. If a mapping changes and a signal
turns out never to have applied, the peak has to come DOWN, and a monotonic column
would keep the old number for ever with nothing to explain it. The replay is the
single source of the number, so the refresh simply writes what it computed.

### 2026-10-29 · 89.2% on "shows intent, then leaves", and why not 90

The brief asks for at least 90% on the simulator "and explain any shortfall". The
measured figure is 89.2% — 58 of 65 — and the explanation is precise: the other 7 peak
at exactly 55, from activating (25), reading pricing (10), deliberating over the plans
(10) and doing the core action three times in their first fortnight (10). They have no
fit points, did not activate faster than the median, and were not active on three of
the last seven days. They are five points below the band.

That is the points table doing what it says. Brief §8.2 is explicit — "Do not invent
points" — and raising a weight to clear a bar on simulated data would be fitting the
rules to the simulator rather than to users. The calibration job exists for exactly
this question: on this run it already suggests raising `fastActivation` and
`fitPoints`, for a founder to approve.

The test asserts 85% so a real regression fails it — the same check read 49.2% before
the two bugs above were fixed — without encoding a number only reachable by inventing
points.

### 2026-10-29 · Intent is refreshed per project, not per person

The ingest pipeline already collects a `recompute-intent` follow-up per person per
batch, and the worker's handler ignores the person and refreshes the project.

The facts for every user come from one query over the project's events, so a thousand
per-person passes would be a thousand copies of the same work. The per-person path
stays unconnected until a score has to be fresh within seconds rather than within the
hour, which is a dashboard question (M9), not an ingest one.

### 2026-10-29 · The deliberation interactions the settled catalog can see

Brief §8.2 lists "the annual toggle, a plan click or the FAQ opened" as pricing
deliberation. Of the three, only the plan click has an event in the settled catalog:
`Plan Selected`. The annual toggle and the FAQ have none, and the catalog is closed
(settled decision 16), so they are not observable unless a founder sends and maps
their own event.

Deliberation therefore rests on the plan click, on active time above the product's own
median for pricing, and on a second proper visit within a week — all three of which
real data carries. `classifyPricingView` keeps the toggle and FAQ as inputs so a
founder who does map such an event gets them without a code change.

### 2026-10-29 · The episode key is text derived from the facts

Brief §4 describes `leak_instances` as holding an "episode number", and brief §8.3
says the unique key on that table is what guarantees one alert per person per leak.

A number cannot do that job. It would have to be derived from a count of existing
rows, and two sweeps running at once would both count the same rows and both insert
episode 2. So the uniqueness is on an episode KEY: text the engine derives from the
facts — the checkout's timestamp, the step entry they went quiet on, the trial's end
date. The same episode produces the same key however often a sweep runs, and a
genuinely new episode produces a different one.

The number is kept beside it for display ("the third time this has happened"), and it
is only ever display.

The practical consequence is that the rules are free to be simple. They return the
same finding on every sweep, as a pure function of the facts should, and nothing in
them has to remember what was already sent.

### 2026-10-29 · Which leaks survive having paid

"Never alert about someone who already paid, was deleted or opted out" (brief §8.3)
cannot be applied uniformly, because two of the nine leaks are ABOUT paying
customers: cancelled-or-payment-failed, and payer-going-quiet.

So the guard takes an `ignorePaid` flag, which those two pass and no other does. The
other two guards — deleted and opted out — have no exception at all: nobody who asked
to be deleted appears in any number anywhere.

The test drives the guard over every per-person leak from a list that is asserted
against the definitions table, so a tenth leak cannot be added without being guarded.

### 2026-10-29 · The quick-exit leak read its own output

`pricingQuickExitAt` was loaded from `leak_instances` — the table the quick-exit leak
writes to. The leak could therefore never fire a first time, and the simulator
reported 0 quick exits out of 406 first-ever pricing views.

It now comes from the pricing classifier, shared with the intent engine, which needs
the same readings for its own two signals. One definition of "quick exit", used by the
leak, the rate and the score.

### 2026-10-29 · Sessions never recorded their end, page count or active seconds

Brief §4 describes a session row as "start, end, active seconds, page count". Ingest
wrote the start. Across a 250-person simulator run: 909 sessions, 0 with `ended_at`,
0 page views counted, 0 active seconds.

The pricing quick-exit rule needs "the session ends within 2 minutes", so with no end
time it could not fire — which is how this was found, a milestone after the SDK that
sends the numbers landed.

Now accumulated per batch and flushed in one statement, like the daily counters:
`ended_at` is GREATEST so a late event cannot shorten a session, and page views and
active seconds are summed from what ARRIVED rather than from what was stored, for the
same reason the daily counters are — a session that went over the volume cap still
had those page views.

`ended_at` is "the last event we have seen in this session". That is the honest
definition: a session has no end event, only a last one. The sweeps run after the
fact, so by the time a rule reads it the session really is over.

### 2026-10-29 · One pricing view, not one row per event describing it

A single visit to the pricing page usually arrives twice: as a page view of a path a
URL rule maps to `Pricing Viewed`, and as a `Pricing Viewed` event the founder sends
by hand. Both were counted.

That did two things. It doubled the denominator of the quick-exit rate — 406 views
where there were 203 — and, worse, it made every visitor's first visit look like their
second, so nothing could ever be a "first-ever pricing view" and the rate read 0.0% on
data where one visitor in seven glances and leaves.

A pricing view is now one row: the page view where there is one, because it carries
the path and can be matched to the `Page Left` that knows how long they stayed, and
the hand-sent event only in a session that has no pricing page view. A project that
sends only the event keeps its views with no active time, which is honest — without a
`Page Left` on the page, nobody told us how long they stayed.

With all three fixed the rate reads 13.8%, 28 of 203, split four ways.

**It also moved an M7 number.** The calibration's precision at threshold 60 was
recorded as 61.0% when M7 landed; it is 46.3% now. Nothing about the score changed —
the pricing +10 simply reaches the people who genuinely read the page, so more
non-payers sit above 60. The lower figure is the true one, and `docs/progress.md` has
been corrected rather than left reading well.

### 2026-10-29 · A Poisson test, not a percentage drop

Brief §8.3 asks for "a one-sided Poisson test" on the step-completion collapse, and
the reason is worth recording because a percentage would have been so much easier.

A step that normally gets 12 completions a day and got 6 is a quiet Tuesday. The same
halving on a step that gets 1,200 a day is an outage. A percentage cannot tell those
apart; a probability can, and the test says so in the fixture.

The CDF is computed with a multiplicative recurrence rather than `λ^i / i!`, which
overflows to Infinity for a λ in the hundreds — exactly the busy step whose collapse
matters most. The minimum-expected check comes first and is not negotiable: without
it a step that usually gets two a day and got none would fire at p = 0.13 on a quiet
Sunday, and the founder would learn to ignore the alert that matters.

### 2026-10-29 · Resolving a leak, and never deleting it

A leak that stops being true is marked `resolved` with the time, and the row stays.
The episode happened, the dashboard's change-against-last-week needs it, and deleting
it would make the product look better than it was.

What resolves what is explicit rather than general: paying answers the four unpaid
leaks, coming back answers the stall and the two quiet leaks, and a deletion or an
opt-out resolves everything about that person. A blanket "any later activity resolves
any leak" would have quietly closed a cancellation because the person logged in again.

### 2026-10-29 · The masked row carries no identifier at all, so the tag is the handle

The obvious way to build a reveal button is to put the person's key in a hidden field.
That would have put a stable per-person identifier on a page whose entire promise is
that it has none — and the exit-check scan would then have had to be taught to ignore
it, which is how a gate stops being a gate.

So the masked shape has no key, the reveal form posts the TAG, and the server finds
the person by recomputing each tag until one matches. That is O(people) per reveal
rather than O(1), bounded by the free plan's tracked-user limit, and it is the right
trade: the scan can stay a blunt search for any identifier, which is what makes it
worth anything.

### 2026-10-29 · The scan looks for the strings, not at the fields

`packages/db/src/__tests__/masking.test.ts` seeds a person with distinctive values and
then searches the serialized JSON for them, rather than asserting that `email` is null
and `name` is a bar.

The difference matters when someone adds a field. A test that checks the known fields
passes forever; a test that searches the output fails the moment a new field carries
something it should not. The same reasoning put the second scan in `pnpm screens`
against rendered HTML: a gate that holds in the serializer and leaks in a template has
still leaked, and only a browser can see the template.

### 2026-10-29 · Twelve dashboard reads, one after another

The dashboard loader ran its twelve reads in a `Promise.all`. A `ScopedDb` is a single
client inside a single transaction, and pg deprecates a query issued while another is
running on that client: it queues them today and throws in pg 9. The "parallel"
version was sequential with a warning attached.

Real parallelism would need a connection each, and a transaction cannot span two
connections — so the reads are now plainly sequential, and `serializeContext` with
them. The warning was how this was noticed, in a test that was otherwise passing.

### 2026-10-29 · A name bar is a fixed width

The masked shape shows a bar where the name is. It is seven blocks whatever the name,
because a bar that matched the real length would answer "is this my one customer
called Jo?" straight from the screen.

### 2026-10-29 · The dashboard cache is keyed on the project, not the URL

Brief §9 asks for dashboard reads to be cached for 60 seconds. The cache holds the
promise rather than the result, so two simultaneous requests do the work once, and a
failed load is evicted rather than cached.

It is keyed on the project id and lives in process, deliberately rather than using the
framework's own caching: these reads depend on the project's PLAN, and a cache keyed
on the URL would serve a paid project's names to a free one after a downgrade.

### 2026-10-29 · Another clock inside SQL

`eventSourceShare` filtered on `received_at > now() - 7 days`. Same bug as the funnel
trend in M6, in a file the lint rule did not cover. The rule now covers the intent and
leak jobs and the dashboard reads as well — and widening it flagged nothing else,
which is the answer that makes widening it worth doing.

### 2026-10-29 · The intent list says "0 now, 100 at their peak", and why

The first screenshots showed "0 high · 0 warm · 207 low" above a list of people at
peak 100, which reads as broken. It is not: the simulated run ends months in the past,
scores halve every quiet week, and the list is everyone who EVER reached 60 while the
counts are where people stand today.

Both numbers are right and the pair is confusing, so the module now says so in one
line rather than leaving a founder to work it out. The list also gained the band
column brief §9 asks for — "a masked list with tag, band, leak and a coarse time" —
which had simply been missed until the screenshot made it visible.

### 2026-10-29 · `pnpm build` never built the apps

CI failed on `pnpm screens` with "apps/web has no build" while the same command
passed locally. The screens script was not at fault: the root `build` script was
`pnpm -r --filter "./packages/**" build`, so `next build` had never run in CI. The web
app's pages and route handlers were the one part of the codebase CI never compiled,
and `pnpm screens` passed here only because a stale `.next` from M9 was lying around.

`build` is now `pnpm -r build`. That also compiles `examples/next-app` against the
published SDK types, which the publishing step will depend on. `next-env.d.ts` is now
ignored for the examples app as it already was for the web app: `next build` and
`next dev` write different contents into it, so a tracked copy flips with whichever
ran last.

The CI ordering is why this hid for four milestones — Formatting runs before Build, so
the churn in that generated file never failed a step that would have pointed at it.

### 2026-10-29 · Quiet hours are a wrapping window, and the day is the founder's

22:00–08:00 is not a range in the arithmetic sense, so `inQuietHours` handles the wrap
rather than comparing two hours. `startHour === endHour` means "always quiet", which
is a legitimate way to say "feed only, never ping me", and `nextMorning` returns the
instant unchanged for it so nothing is held forever.

`nextMorning` steps hour by hour instead of adding ten hours, because the night a zone
leaves daylight saving is 25 hours long: adding a fixed offset releases that night's
held alerts at 07:00 local. There is a test for exactly that night in Berlin.

The 10-a-day cap counts against the founder's LOCAL day. A UTC day would reset a
founder in Auckland's cap in the middle of their afternoon, giving them ten alerts
before it and ten after. `startOfLocalDay` reads the zone's offset back out of `Intl`
and resolves it twice, so it is right for half-hour zones and for the night an offset
changes.

### 2026-10-29 · The alert guards are re-checked at send time, not trusted

Every per-person leak already applies the three guards when it is recorded. The alert
policy applies them AGAIN, against freshly loaded facts. A last-moment drop found on
Monday for someone who paid on Tuesday must not be sent on Wednesday, and the only way
to know that is to look again now.

Which leaks skip the paid guard is now a field on the leak definition
(`aboutPayers`) rather than a list inside the dispatcher. Two places that must agree
is one place too many (rule 11).

### 2026-10-29 · A held alert spends a slot in the daily cap

The cap could have counted only what was sent. Then a quiet night would hold thirty
alerts and deliver all of them at 08:00, which is the exact thing the cap exists to
prevent. A held alert is going to arrive, so it spends its slot when it is decided.

### 2026-10-29 · The Discord embed carries no timestamp

Discord renders `timestamp` to the minute in the viewer's own zone. A masked alert
with a minute on it can be matched against the founder's server log or Stripe, which
is the attack the coarse times exist to stop (brief §9). The `When` field carries
"today" or "this week" instead, and a test asserts no ISO timestamp appears anywhere
in the payload.

### 2026-10-29 · One neutral alert, rendered twice

`alertContent` builds a channel-agnostic shape and `toSlack`/`toDiscord` render it.
Neither renderer ever sees a name: by the time a payload is built, `who` is already a
tag or already a name and the decision was taken once, in the data-access layer. A
renderer that could mask would be a second place to get masking wrong.

Both shapes were verified against the live docs rather than from memory (brief §12),
on 2026-10-29. Slack's advanced sample sets `text` alongside `blocks`, which is what a
phone notification shows — without it a push reads "This content can't be displayed".
Discord's documented maxima are enforced in code, including the 6,000 characters
across the whole message; the description is what gets shortened, because it is the
only field whose length the founder's own step labels control.

### 2026-10-29 · The payback line is USD only, and 24.99 is one constant

Brief §9 part 8 asks for the line only when the project's currency is USD. Converting
would need a rate, a rate has a date, and a sentence about what our own plan costs is
the last place to show a number we cannot show the working for. `STARTER_PRICE_MINOR`
is 2499 in minor units, matching the `starter` row seeded in migration 0001, so the
two move together or the report lies.

### 2026-10-29 · "Too early to tell" is a number, not a shrug

The Changes comparison needs 100 users entering the step in EACH window, not 100
across both: 180 before and 20 after is still too early. Rather than saying only "too
early", it says how many more are needed on the thinner side, which turns an
indefinite wait into one with an end.

The windows are equal by construction and widen day by day until the plan's cap. A
7-day "after" against a 45-day "before" compares a week of one product against six
weeks of another, and whichever way the number moved the founder would have learnt
nothing.

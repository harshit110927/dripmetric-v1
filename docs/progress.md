# Progress

Milestones M0–M13 with their exit checks, copied from brief §11 on 2026-10-28. One
milestone per go-ahead; M0 and M1 together first. Tick a box only when the check has
actually been run and its command is in the milestone report.

Legend: `[ ]` not done · `[~]` in progress · `[x]` done and proven

---

## M0 · Foundations — `[x]`

**Build:** pnpm monorepo with the brief §4 layout; Docker Compose (Postgres, web, worker);
CI; env validation; plain-SQL migrations for `projects`, `api_keys`, founder users and
sessions (magic-link login: a console mailbox in dev, Resend in production), `plans` and
`audit_log`; the scoped query helper; `can(project, feature)`; project creation with live
and test keys; `packages/catalog` holding Appendix A as typed data and Zod schemas; the
three living files.

- [x] `pnpm install && pnpm dev` brings up web, worker and Postgres
- [x] tests and CI are green
- [x] sign in with a magic link, create a project, see its keys (secret shown once, stored hashed)
- [x] a test proves a query without a project cannot be written
- [x] a test counts every event name from Appendix A in the catalog package

## M1 · Ingest API and storage — `[x]`

**Build:** `packages/ingest` and the `/v1/batch` and `/v1/import` handlers (brief §5): all
three key forms, limits, rate limits, dedupe, filters, enrichment, identity linking, the
compact tables, `user_step_state`, the daily cap, tracked-user rows, the OpenAPI spec and
pg-boss wired up.

- [x] the curl example in Appendix B returns a per-message result
- [x] replaying it changes nothing
- [x] a batch with one bad message returns 200 with one error
- [x] a 600 KB batch returns 413 and a 33 KB message errors alone
- [x] a publishable key cannot set `stripeCustomerId` or send billing events
- [x] a wrong origin is refused
- [x] the rate limit returns 429 with `Retry-After`
- [x] a `text/plain` beacon body is accepted
- [x] on 200,000 generated events, measured bytes/event (indexes included) within 20% of 215 — **245.0 B/event** (heap 124.3, indexes 120.7)
- [x] a 1,000-event batch inserts quickly — **803 events/second**, 1,000 events in 1.25 s

**→ STOPPED. First report sent 2026-10-28. Waiting for "continue".**

111 tests, 11 files. `pnpm verify` green (script names, lint, format, typecheck, licences, tests) plus `pnpm build`.

## M2 · Simulator and test harness — `[x]`

**Build:** `packages/sim` (brief §10): three products, personas, fault injection, a virtual
clock, a truth file, payload emitters for Segment, RudderStack and PostHog, and `pnpm sim`.

- [x] `pnpm sim --product selfserve --users 300 --seed 1` loads events through the HTTP API and writes a truth file — 6,458 messages, 6,326 stored, 129 filtered, 0 errors
- [x] the same seed gives identical data
- [x] injected duplicates do not change counts
- [x] late events are accepted and flagged `late`

**Scored against truth, all three products at 100%** (filtered / tracked / paid /
stalls visible / intent signals), and still 100% with duplicates, late events and
clock skew injected together. Found and fixed five real bugs in M1's pipeline; see
docs/decisions.md.

## M3 · Browser SDK — `[x]`

**Build:** the browser library (brief §6), an example page and Playwright tests.

- [x] with consent required and not given: no network request, nothing stored (cookies, localStorage)
- [x] after `consent(true)` queued events flush with their original timestamps
- [x] an SPA route change produces Page Viewed and Page Left with active-time totals
- [x] hiding the tab sends a beacon
- [x] with the network blocked the page stays responsive and nothing throws
- [x] core ≤ 5 KB gzipped (CI fails above it); lazy chunk size reported — **core 5,018 B**, lazy chunk 1,556 B, script tag 6,488 B

14 Playwright checks green (`pnpm test:e2e`). The published tarball is 25 files:
`dist`, README, LICENSE, package.json — verified with `npm pack --dry-run`.

## M4 · Server SDK — `[x]`

**Build:** the Node library, the serverless flush helper, the identity-verification helper,
an example Next.js app.

- [x] the example sends Signed Up, Activated and Checkout Started
- [x] killing the ingest server mid-send neither throws nor blocks the request
- [x] the serverless helper delivers after the response
- [x] `stripeCustomerId` from a browser key refused, from the server accepted

Also here, early, because the SDK's `deleteUser()` would otherwise be a method that
404s: `DELETE /v1/users/:userId`, with its own tests. M11 adds the audit-log view and
the retention job around it.

## M5 · Product model and event matching — `[x]`

**Build:** brief §7: URL rules, the event dictionary and Inbox, AI suggestions (a real call
behind an env var, a mock in tests), the five product facts and setup logic, paid-event
gating, the `recompute` job, the coverage checklist.

- [x] with renamed simulator events, the Inbox lists the unmapped names
      (`packages/sim/src/__tests__/ingest.test.ts`: the `renamed-event` fault over 80
      seeded users; the new name is `unmapped` with its events behind it, and mapping
      it rebuilds the step state that arrived under it)
- [x] the mock AI proposes mappings (`packages/ingest/src/__tests__/mapping.test.ts`:
      stored as `suggested` with a reason and a confidence; one retry on an unusable
      reply; a confirmed name is never overwritten)
- [x] confirming one recomputes history (0 step-state rows before the mapping, 2
      after, from events that arrived while the name was unmapped)
- [x] the equivalence test passes (recompute == ingest with final mapping from the
      start) — `packages/ingest/src/__tests__/recompute.test.ts`
- [x] the scrub test shows no email, phone, id or token reaches the model prompt (a
      mock records the exact prompt; email, token, URL with query, Stripe-style id and
      a person's name are all absent, the property KEYS are present, and the withheld
      list is audited)

Also proven live, against the running dev stack: the setup screen shows the five
questions with where each answer came from, the paid-event note and the switched-off
table; the Inbox lists the unmapped name with the meanings it may be mapped to; a
queued `recompute_runs` row was found by the worker sweep within a minute, fanned out
and drained to `done`.

## M6 · Funnel and timing engine — `[x]`

**Build:** brief §8.1 as pure functions, worker jobs, hourly and daily aggregates, segment
splits, retention cohorts (week 1 and week 4), the API the dashboard reads.

- [x] per-step drop-off, medians and stuck counts match the truth file
      (`packages/sim/src/__tests__/funnel.test.ts`, one 200-person run: completions
      exact against `stepsCompleted`, signed up / activated / paid exact against the
      totals, and 91 of the 91 people the truth file says stalled reported as stuck
      — 100.0%, printed by the test — with no payer counted stuck)
- [x] fixtures cover stuck, cooling, rushed and the highlight logic
      (`funnel-classify.test.ts` and `funnel-highlight.test.ts`: both stuck rules and
      the Key-step-only limit, cooling before and after moving on, skimmed needing
      both halves, and all three highlight readings with the plain sentence each
      produces)
- [x] thresholds freeze when a change is marked — proven by loading a second,
      different 120-person run after the freeze and showing every bar unmoved
- [x] percentiles appear only after 20 completions (`funnel-stats.test.ts` walks 0–19
      and then exactly 20; the funnel test checks it against real data, including the
      honest case: a step reached only by a server event has a drop-off and no
      duration, because we never learn when anyone started it)

Also built: `user_step_sessions`, which makes `visits` an absolute recount instead of
a per-batch counter that undercounted every returning visitor, and gives the segment
splits the session a person was actually in.

## M7 · Intent engine — `[x]`

**Build:** brief §8.2: signals and points, decay, peak, bands, accounts, the calibration
job, per-project config, "intent but didn't pay", a potential-revenue function that returns
its formula text.

- [x] a fixture test for every row of the points table, incl. the fit cap, the clamp
      at 0, shared signals (`intent-score.test.ts`: the table drives the cases, so a
      row cannot be added without one; the cap drops the extras and says which; the
      shared pairs are one column each, so counting twice is unexpressible)
- [x] a decay test (0, 7, 14, 21 and 28 quiet days; a half-week; and the cap applied
      before the decay rather than after, which is the difference between 50 and 55)
- [x] replaying events twice gives identical scores — byte-identical `intent_state`
      rows over a 300-person run, because the peak and `first_high_at` are replayed
      from when each signal became true rather than stamped when a refresh ran
- [x] the simulator report prints the share of "shows intent, then leaves" users who
      reached 60 — **89.2%** (58 of 65). The other 7 peak at exactly 55 and the
      shortfall is printed with them; see `docs/decisions.md`. Two bugs found on the
      way: the same figure read 49.2% before them.
- [x] the calibration job prints recall, precision and lift on a product with ≥ 30
      payers — 50 payers of 281 users: recall 100.0%, precision 46.3%, a lift per
      signal, and two weight changes offered for approval and never applied.
      (Precision read 61.0% when M7 landed. M8 found that each pricing view was
      counted twice, which had been withholding the pricing +10 from people who
      genuinely read the page; with them scored correctly, more non-payers sit above
      60 and the honest figure is lower. See `docs/decisions.md`.)

## M8 · Leak engine — `[x]`

**Build:** brief §8.3: all nine leaks with episodes and resets, the sweeps, the adaptive
stall, the quick-exit rate.

- [x] fixtures with time travel for every leak (`packages/engine/src/__tests__/leaks.test.ts`,
      46 cases including the brief's own worked example: "enters step 2 at t0, no
      event for 49 hours: exactly one stall")
- [x] each fires exactly once per episode; a returning user resets it — proven twice:
      in the engine (the same episode yields the same key, a return yields a new one)
      and against the database, where the unique index refuses the second insert
- [x] none fires for a paid, deleted or opted-out user — driven over every per-person
      leak, so a tenth leak that forgot the guard would fail the test; and checked
      again over a 250-person simulator run that contains real payers
- [x] the collapse test fires only when ≥ 10 completions were expected and p < 0.01
      (including the case the minimum-volume check exists for: the same halving is
      noise on a 12-a-day step and an outage on a 1,200-a-day one)
- [x] the simulator report prints the share of stalled users caught — **100.0%**,
      91 of 91
- [x] a leak lacking the paid event or trial dates shows as off, with its reason

Also measured on that run: 13.8% of first-ever pricing views are quick exits (28 of
203), split by source, device, country and trial day; and every per-person leak
reports its potential revenue with the formula beside it.

## M9 · Dashboard, masking and entitlements — `[x]`

**Build:** the eight modules from real data, the settings page, masked and full
serializers, the reveal allowance, plain-language copy, empty/loading/error states.

- [x] all modules render from simulator data — `pnpm screens` fails if a module's
      heading is missing, and it runs in CI
- [x] the formula is visible beside potential revenue — in the leak table, the intent
      module and every per-leak figure; see `docs/screens/02-leaks.png`
- [x] an automated scan: a free project's API and HTML contain no seeded email, name
      or user id; a paid project shows them. **Both halves**: the data-access layer's
      serialized output (`packages/db/src/__tests__/masking.test.ts`, which scans the
      JSON for the seeded strings rather than checking that particular fields look
      right) and the rendered HTML (`pnpm screens`), because a gate that holds in a
      serializer and leaks in a template has still leaked.
- [x] the reveal allowance works (default 0) — refuses with a reason at 0, reveals
      exactly the person it was spent on, costs nothing to repeat, runs out, and
      writes every reveal to the audit log
- [x] screenshots of every module saved in `docs/screens/` — 13 of them, with
      `docs/screens/README.md` recording the scan's result

The masked rows carry a tag, an email hint, a fixed-width bar and a coarse time, and
nothing else: there is no identifier on a masked page at all, which is why the reveal
button posts the tag and the server resolves it.

## M10 · Alerts and reports — `[x]`

**Build:** Slack and Discord OAuth (against mocks), encrypted webhook URLs, the in-app feed
with an unread badge, the 10-a-day cap, quiet hours, the daily digest, Resend system email,
the weekly report, the Changes comparison, the dev preview route.

- [x] a Monday run produces the 8-part report with correct numbers — the eight parts
      in the brief's order (`reports.test.ts` asserts the key list), the subject is
      "7 users with buying intent didn't pay last week" over 7 seeded high-intent
      non-payers, and the payback line is `ceil(24.99 / price)`: $9.00 → "saving 3".
      It is skipped on a Sunday, before 08:00 local, and a second time the same week.
- [x] the 11th alert in a day goes only to the feed — 10 posted, the 11th in the feed
      saying "that is 10 alerts today, which is the daily limit", and the cap survives
      a second sweep because it counts what was SENT, not what was decided
- [x] an alert in quiet hours is held until morning — raised 23:30 Berlin, nothing
      posted overnight, delivered at 08:00 local the next day. A held alert spends a
      slot in the cap, so a quiet night cannot stack thirty posts for 08:00.
- [x] payloads match the samples in Slack's and Discord's docs — both verified against
      the live docs on 2026-10-29 and enforced in code: Slack sets `text` alongside
      Block Kit `blocks` (its own advanced sample does, and without it a phone push
      reads "This content can't be displayed"); Discord's maxima including the 6,000
      across the message. The embed carries NO timestamp, because Discord renders it
      to the minute and a masked alert with a minute on it can be matched against the
      founder's own logs.
- [x] no alert for a paid, deleted or opted-out user — driven over all four guards
      (internal too). The guards are re-checked at SEND time against fresh facts, so
      a leak found on Monday for someone who paid on Tuesday is dropped on Wednesday.
      Nothing is written to the feed either: the feed is a list of things to act on.
- [x] Changes says "too early to tell" under 100 users per window — 120 before and 40
      after reads "60 more users on the thinner side"; 150/150 prints "went from 40.0%
      to 60.0% across 300 users" and freezes, so reading it a week later gives the
      same sentence the founder was already told.

**Also:** 15 alert + 15 report integration tests against a real database, 55 engine
tests. The OAuth flow runs unchanged against a mock at `/dev/oauth/<kind>/<step>` —
same state nonce, same single-use spend, same code exchange; only the host differs.
`/dev/preview?project=<id>` renders the report and an example alert from the same
engine functions the jobs use, with `&as=text|slack|discord`.

Three real bugs the tests found: `changeWindowCounts` was written against
`entered_at`/`completed_at`, which do not exist (`first_entered_at` /
`first_completed_at` do); `resetData` deleted `funnel_steps` before `changes`, whose
composite `ON DELETE SET NULL` then tried to null a NOT NULL `project_id`; and a
project that had never sent an event would have been emailed every Monday about its
switched-off metrics, which is not broken tracking but an empty setup screen.

## M11 · Tracking health, retention and deletion — `[ ]`

**Build:** tracking health (brief §9), nightly summaries and retention job, `deleteUser`,
`DELETE /v1/users/:userId`, an audit-log view, the legal placeholder pages.

- [ ] stopping a key event raises a tracking alert within one sweep, not a "users vanished" alert
- [ ] shape drift and double-sent events are detected
- [ ] the nightly job writes summaries first, deletes only raw events past the window
- [ ] deleting a user removes every row for them (verified with SQL) and is audited

## M12 · Source adapters, free audit and AI-coder prompt — `[ ]`

**Build:** the Segment, RudderStack and PostHog adapters (signature checks, the PostHog
allow-list, one source path per event), the email-only instant project flow with claim and
expiry, first-event detection, the AI-coder prompt generator.

- [ ] recorded Segment/RudderStack/PostHog payloads produce the same canonical events as native SDK sends
- [ ] a bad signature gets 401
- [ ] PostHog events outside the allow-list are dropped and counted
- [ ] the double-path warning appears
- [ ] the free-audit flow works end to end locally (email, keys, first event, dashboard)
- [ ] generated samples for Node, Python (via Segment's library) and plain HTTP run against local ingest

## M13 · Hardening, shadow copy and load test — `[ ]`

**Build:** dual writes to a shadow Postgres through the worker queue; shadow reads that log
differences and latency; a daily reconciliation job; scripts for the monthly drills; a load
test; Sentry; structured logs; queue-health metrics; security headers; the licence check in
CI; a runbook, a README, SDK docs and a measured size and cost report.

**Guard:** in production mode, refuse to create live (non-test) projects unless
`BACKUPS_CONFIRMED=true`.

- [ ] reconciliation shows zero gaps on a simulator run
- [ ] killing the shadow does not slow ingest
- [ ] the load-test report names the ceiling
- [ ] every drill has a written result in `docs/runbook.md`

# Runbook

What to do when something breaks, and the drills that prove we can.

Everything here is **dev-only** as written: there are no production credentials in
this repository (CLAUDE.md rule 3). `docs/publishing.md` covers going live.

---

## The one gate that matters

**Settled decision 1: no real founder data until the shadow copy or Supabase Pro
backups exist.** Supabase Free has no backups.

The code enforces this. In production, creating a live project is refused unless
`BACKUPS_CONFIRMED=true` is set — see `liveProjectsAllowed()` in
`apps/web/src/lib/env.ts`. Setting that variable is a statement that backups exist; it
does not create them.

The worker also says so at startup when no shadow is configured, so a deployment
without either is never silent about it.

---

## Local setup

```
pnpm install
pnpm db:up            # primary Postgres on 54329
pnpm db:migrate
pnpm shadow:up        # shadow Postgres on 54330 (optional)
pnpm shadow:migrate   # the SAME migrations — a drifted schema is not restorable
pnpm dev              # web on :3000 and the worker
```

`SHADOW_DATABASE_URL` is what turns the shadow on. Without it everything works and
the shadow paths do nothing, which is a supported state.

---

## When ingest is slow

Check these in order, because the cheap answers are also the common ones.

1. **Is it the rate limiter?** A burst of 429s is the limiter working, not a fault.
   `pnpm load` reports them separately for this reason, and the per-project ceiling
   measured on one laptop is in `docs/load-test.json`.
2. **Queue depth.** The worker logs `queue health` every minute when anything is
   pending. A growing `recompute` or `shadow-copy` queue means the worker is behind,
   not that ingest is.
3. **Is it the shadow?** It cannot be. Ingest never opens a connection to the shadow —
   it queues message hashes and returns. If the shadow were somehow in the request
   path, `shadow.test.ts` would fail. Check the worker's `shadow health` lines instead.
4. **Round trips.** A batch is about 38 SQL statements and 5 transactions, so ingest is
   round-trip bound rather than CPU bound. A slower network between app and database
   shows up as a proportional slowdown. This is the known shape; see
   `docs/decisions.md`, "the simulator's tiny batches are deliberate".

---

## When the shadow is behind

`pnpm shadow:reconcile` names the tables and the sizes of the gaps, and exits
non-zero.

A gap is usually one of three things:

- **Jobs queued and not drained.** Check the worker is running and the `shadow-copy`
  queue depth. The jobs are durable, so starting the worker fixes it.
- **The shadow was down when a batch was copied.** The copy is skipped and logged, not
  retried forever. The nightly reconciliation is what notices; re-copying a specific
  window is a manual step today, which is a known limitation and written down as one.
- **Retention ran on one and not the other.** The primary deletes events past the
  window; the shadow currently does not. A negative `missing` (shadow AHEAD) after a
  retention run is this, and it is expected rather than a fault.

---

## When an alert channel stops working

The founder's settings screen shows `last_error` for each integration, and the alert
feed shows what became of every alert — sent, held, retried, failed or skipped. Nothing
is lost: the feed is the record and a channel is a convenience on top of it.

A 404 or 410 from a webhook ends the retries deliberately: the channel or the app is
gone, and the useful action is telling the founder rather than retrying four more
times.

---

## When tracking looks broken

`tracking_findings` is the table. The alerts it raises say TRACKING, never "users
vanished" — that wording is a requirement, not a style choice, because a missing
`Signed Up` is indistinguishable in the data from nobody signing up.

The baseline deliberately excludes the window it judges, so an outage cannot drag its
own baseline down and quietly stop firing.

---

## Deleting a person

`DELETE /v1/users/:userId` with the **secret** key. It is idempotent, it is audited,
and it removes every row that holds that user key — verified against
`information_schema` rather than against a hand-written list, because that list was
wrong twice.

---

## Rotating a key

Keys are stored hashed; a secret key's token is never stored at all. So a lost secret
key cannot be recovered, only replaced. Rotate in settings, then update the
environment variable wherever it is set. Any source feed using the old key stops
working, by design — see `liveSourceSecret`, which refuses a feed whose key is revoked.

---

## The monthly drills

```
node scripts/drill.mjs list
node scripts/drill.mjs reconcile
node scripts/drill.mjs kill-shadow
node scripts/drill.mjs restore
```

Each one appends a dated result below. Append, never rewrite: the history is the
value, because a restore that took 40 seconds last quarter and 400 this one is the
finding.

### What a real restore looks like

The local `restore` drill proves the shadow has the schema and the rows. A production
restore is:

1. Stop the worker, so nothing is writing.
2. Point `DATABASE_URL` at the shadow.
3. Run `pnpm db:migrate` against it — it should be a no-op, and if it is not, the
   schemas had drifted and that is the real finding.
4. Start the web app and check one founder's dashboard renders.
5. Start the worker.

Settled decision 1 is satisfied by this being possible, not by it being easy.

## Drill log

Appended by `node scripts/drill.mjs`.

### 2026-10-29 · drill: reconcile — FAILED

```
/home/user/dripmetric-v1/apps/worker:
 ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  @dripmetric/worker@2.0.0 reconcile: `tsx src/cli/reconcile.ts`
Exit status 1
 ELIFECYCLE  Command failed with exit code 1.
SHADOW_DATABASE_URL is not set, so there is nothing to reconcile.
Locally: `pnpm shadow:up && pnpm shadow:migrate`, then set it in .env.
Settled decision 1: no real founder data until the shadow copy or Supabase Pro
backups exist.
```

### 2026-10-29 · drill: reconcile — passed

```
events              0         0         0
  end_users           0         0         0
  accounts            0         0         0
  sessions            0         0         0

  took 453ms

Clean.
```

### 2026-10-29 · drill: restore — passed

```
events=0 end_users=0 projects=0 tables=50
(a restorable shadow needs the full schema, not just rows)
```

### 2026-10-29 · drill: kill-shadow — passed

```
ok: stop the shadow (184ms)
  ok: ingest with no shadow (6159ms)
  ok: start the shadow (202ms)
```

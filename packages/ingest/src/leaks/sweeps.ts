import { withProject, type ScopedDb } from '@dripmetric/db';
import {
  LEAK_DEFINITIONS_BY_TYPE,
  leakIsAvailable,
  potentialRevenue,
  stepCollapse,
  unavailableLeaks,
  userLeaks,
  type LeakFinding,
  type LeakType,
  type LeakUnavailable,
  type PotentialRevenue,
} from '@dripmetric/engine';
import { loadPricingReadings } from '../intent/facts.js';
import { intentContextFor } from '../intent/state.js';
import { leakAvailability, loadCollapseFacts, loadUserLeakFacts } from './facts.js';

/**
 * The leak sweeps (brief §8.3).
 *
 * "The engine is event-driven where it can be, and otherwise runs on sweeps (every 5
 * minutes, hourly for the collapse test)."
 *
 * Each sweep loads facts, calls the pure rules and records what they found. Recording
 * is an insert that ignores conflicts, so "one alert per person per leak" is enforced
 * by the unique index rather than by remembering to check — the rules themselves
 * happily return the same finding on every run, and should.
 */

export interface SweepResult {
  /** Findings the rules produced, before the uniqueness check. */
  found: number;
  /** Rows that actually landed: the new episodes. */
  recorded: number;
  /** Leaks that cannot run yet, with their reasons (brief §8.3). */
  off: LeakUnavailable[];
  byType: Partial<Record<LeakType, number>>;
}

/**
 * Stores findings, keeping one row per episode.
 *
 * The episode number is computed from what is already stored, so a founder can be
 * told "the third time this has happened" — but it is display only. The unique index
 * on the episode KEY is what makes the guarantee, because a number derived from a
 * count would race two sweeps against each other.
 */
export async function recordFindings(
  db: ScopedDb,
  findings: readonly LeakFinding[],
): Promise<number> {
  if (findings.length === 0) return 0;

  const inserted = await db.query<{ id: string }>(
    `WITH incoming AS (
       SELECT * FROM unnest(
                $2::text[], $3::int[], $4::text[], $5::text[],
                $6::timestamptz[], $7::text[], $8::jsonb[]
              ) AS f(subject_kind, subject_key, leak_type, episode_key, fired_at, says, details)
     ), numbered AS (
       SELECT i.*,
              1 + (
                SELECT count(*) FROM leak_instances l
                 WHERE l.project_id = $1
                   AND l.subject_kind = i.subject_kind
                   AND l.subject_key = i.subject_key
                   AND l.leak_type = i.leak_type
              )::int AS episode
         FROM incoming i
     )
     INSERT INTO leak_instances (
       project_id, subject_kind, subject_key, leak_type, episode_key,
       episode, fired_at, says, details
     )
     SELECT $1, subject_kind, subject_key, leak_type, episode_key,
            episode, fired_at, says, details
       FROM numbered
     ON CONFLICT (project_id, subject_kind, subject_key, leak_type, episode_key)
       DO NOTHING
     RETURNING id`,
    [
      db.projectId,
      findings.map((f) => f.subject),
      findings.map((f) => f.subjectKey),
      findings.map((f) => f.type),
      findings.map((f) => f.episodeKey),
      findings.map((f) => f.firedAt),
      findings.map((f) => f.says),
      findings.map((f) => JSON.stringify(f.details)),
    ],
  );

  return inserted.length;
}

/**
 * The five-minute sweep: every per-person leak.
 *
 * The rules that belong to the hourly or daily sweeps are run here too and cost
 * nothing extra — the facts are already loaded, and recording is idempotent. What the
 * cadence in the brief buys is how quickly a founder hears, not which rules run.
 */
export async function sweepUserLeaks(db: ScopedDb, now: Date): Promise<SweepResult> {
  const available = await leakAvailability(db);
  const off = unavailableLeaks(available);

  const facts = await loadUserLeakFacts(db, now);
  const findings = facts
    .flatMap((user) => userLeaks(user, now))
    // A leak whose data does not exist cannot fire, even if the rule would: the
    // numbers it would produce would be about an absence.
    .filter((finding) => leakIsAvailable(finding.type, available));

  const byType: Partial<Record<LeakType, number>> = {};
  for (const finding of findings) byType[finding.type] = (byType[finding.type] ?? 0) + 1;

  return {
    found: findings.length,
    recorded: await recordFindings(db, findings),
    off,
    byType,
  };
}

/** The hourly sweep: the step-completion collapse test (brief §8.3). */
export async function sweepStepCollapse(db: ScopedDb, now: Date): Promise<SweepResult> {
  const facts = await loadCollapseFacts(db, now);
  const findings = facts
    .map((fact) => stepCollapse(fact, now))
    .filter((finding): finding is LeakFinding => finding !== null);

  return {
    found: findings.length,
    recorded: await recordFindings(db, findings),
    off: [],
    byType: findings.length > 0 ? { 'step-collapse': findings.length } : {},
  };
}

/**
 * Resolves the instances that have stopped being true.
 *
 * A leak that resolves itself is not an embarrassment to hide — it is the best news
 * the product can deliver, and the dashboard's change-against-last-week is wrong
 * without it. Resolution never deletes the row: the episode happened.
 */
export async function resolveLeaks(db: ScopedDb, now: Date): Promise<number> {
  return db.exec(
    `UPDATE leak_instances l
        SET state = 'resolved', resolved_at = $2
       FROM end_users u
      WHERE l.project_id = $1
        AND u.project_id = l.project_id
        AND l.subject_kind = 'user'
        AND u.user_key = l.subject_key
        AND l.state = 'open'
        AND (
          -- They paid after the leak fired: every unpaid leak is answered.
          (u.paid_at IS NOT NULL AND u.paid_at > l.fired_at
             AND l.leak_type IN ('last-moment-drop', 'high-intent-quiet',
                                 'trial-ended-unpaid', 'limit-reached-no-upgrade'))
          -- They came back: the stall and the quiet are over.
          OR (u.last_event_at IS NOT NULL AND u.last_event_at > l.fired_at
              AND l.leak_type IN ('onboarding-stall', 'high-intent-quiet',
                                  'payer-going-quiet'))
          -- They asked to be deleted or opted out: no number is about them.
          OR u.deleted_at IS NOT NULL
          OR u.opted_out
        )`,
    [db.projectId, now],
  );
}

export interface LeakSummary {
  computedAt: Date;
  /** Open instances per leak type, with the rule each one applied. */
  byType: {
    type: LeakType;
    rule: string;
    open: number;
    firedThisWeek: number;
    /** Leaked users × the list price, with the formula (brief §8.3). */
    potentialRevenue: PotentialRevenue | null;
  }[];
  totalOpen: number;
  /** Leaks that are off, and why. */
  off: LeakUnavailable[];
  /** The pricing quick-exit rate, split the four ways the brief asks for. */
  quickExit: QuickExitRates;
}

export interface QuickExitRates {
  /** Quick exits as a share of first-ever pricing views. Null with no views. */
  overall: number | null;
  views: number;
  exits: number;
  bySource: { value: string; views: number; exits: number; rate: number }[];
  byDevice: { value: string; views: number; exits: number; rate: number }[];
  byCountry: { value: string; views: number; exits: number; rate: number }[];
  byTrialDay: { value: string; views: number; exits: number; rate: number }[];
}

/**
 * The leak summary the dashboard and the weekly report read (brief §9).
 *
 * "Each leak also shows potential revenue (leaked users × the founder's list price)
 * with the formula on screen. Never add it to Stripe dollars." The formula comes back
 * with the number, so a screen cannot show one and compute the other.
 */
export async function leakSummary(db: ScopedDb, now: Date): Promise<LeakSummary> {
  const available = await leakAvailability(db);
  const context = await intentContextFor(db);

  const rows = await db.query<{
    leak_type: LeakType;
    open: string;
    this_week: string;
    subjects: string;
  }>(
    `SELECT leak_type,
            count(*) FILTER (WHERE state = 'open')::text AS open,
            count(*) FILTER (WHERE fired_at > $2::timestamptz - interval '7 days')::text AS this_week,
            count(DISTINCT subject_key) FILTER (WHERE state = 'open')::text AS subjects
       FROM leak_instances
      WHERE project_id = $1
      GROUP BY leak_type`,
    [db.projectId, now],
  );

  const byType = rows.map((row) => {
    const definition = LEAK_DEFINITIONS_BY_TYPE.get(row.leak_type);
    return {
      type: row.leak_type,
      rule: definition?.rule ?? '',
      open: Number(row.open),
      firedThisWeek: Number(row.this_week),
      potentialRevenue:
        // A leak about a step is not a leak about people, so it has no money figure.
        definition?.subject === 'step'
          ? null
          : potentialRevenue(
              Number(row.subjects),
              context.listPrice.amount,
              context.listPrice.currency,
              context.listPrice.interval,
            ),
    };
  });

  return {
    computedAt: now,
    byType: byType.sort((a, b) => b.open - a.open),
    totalOpen: byType.reduce((sum, entry) => sum + entry.open, 0),
    off: unavailableLeaks(available),
    quickExit: await quickExitRates(db),
  };
}

/**
 * The quick-exit rate, "by source, device, country and trial day" (brief §8.3).
 *
 * Computed from the pricing classifier's readings rather than from the stored
 * instances, for two reasons:
 *
 *  - Anonymous visitors count. Brief §8.2: "Anonymous visitors count in rates, not
 *    dollars." A `leak_instances` row is about a person, so a rate built from that
 *    table would count every visitor in its denominator and only signed-up users in
 *    its numerator — reading lower the more anonymous traffic a founder had.
 *  - One definition. The classifier decides what a quick exit is, here and in the
 *    leak and in the intent signals.
 *
 * The denominator is every pricing view, and only a first-ever view can be a quick
 * exit, which is the rule's own wording rather than an approximation.
 */
export async function quickExitRates(db: ScopedDb): Promise<QuickExitRates> {
  const readings = await loadPricingReadings(db);
  const views = readings.length;
  const exits = readings.filter((reading) => reading.countsAsLeak).length;

  const split = (pick: (reading: (typeof readings)[number]) => string) => {
    const totals = new Map<string, { views: number; exits: number }>();
    for (const reading of readings) {
      const key = pick(reading);
      const entry = totals.get(key) ?? { views: 0, exits: 0 };
      entry.views += 1;
      if (reading.countsAsLeak) entry.exits += 1;
      totals.set(key, entry);
    }
    return [...totals.entries()]
      .map(([value, entry]) => ({
        value,
        views: entry.views,
        exits: entry.exits,
        rate: entry.views === 0 ? 0 : entry.exits / entry.views,
      }))
      .sort((a, b) => b.exits - a.exits || b.views - a.views);
  };

  return {
    overall: views === 0 ? null : exits / views,
    views,
    exits,
    bySource: split((reading) => reading.source),
    byDevice: split((reading) => reading.device),
    byCountry: split((reading) => reading.country),
    byTrialDay: split((reading) => reading.trialDay),
  };
}

/** Adds the leak section to the day's summary, beside the funnel's and intent's. */
export async function writeLeakSummary(db: ScopedDb, now: Date): Promise<void> {
  const summary = await leakSummary(db, now);
  await db.exec(
    `INSERT INTO daily_summaries (project_id, day, payload, computed_at)
     VALUES ($1, $2::date, $3::jsonb, $4)
     ON CONFLICT (project_id, day) DO UPDATE SET
       payload = daily_summaries.payload || EXCLUDED.payload,
       computed_at = EXCLUDED.computed_at`,
    [db.projectId, now.toISOString().slice(0, 10), JSON.stringify({ leaks: summary }), now],
  );
}

/** The five-minute pass for one project, as the worker runs it. */
export async function runLeakSweep(projectId: number, now: Date): Promise<SweepResult> {
  return withProject(
    projectId,
    async (db) => {
      await resolveLeaks(db, now);
      return sweepUserLeaks(db, now);
    },
    { worker: true },
  );
}

/** The hourly collapse pass for one project. */
export async function runCollapseSweep(projectId: number, now: Date): Promise<SweepResult> {
  return withProject(projectId, (db) => sweepStepCollapse(db, now), { worker: true });
}

import {
  browserShare,
  doubleSentEvents,
  eventRates,
  lateShare,
  openTrackingFindings,
  propertyShapes,
  recordAlert,
  recordTrackingFinding,
  resolveTrackingFindings,
  withProject,
  type ScopedDb,
} from '@dripmetric/db';
import {
  BASELINE_DAYS,
  MISSING_EVENT_HOURS,
  doubleSent,
  lateEvents,
  missingEvents,
  shapeDrift,
  sourceShareCollapse,
  type HealthFinding,
} from '@dripmetric/engine';
import { smallIntToSource, sourceToSmallInt, FLAG_LATE } from '../pipeline/events.js';

/**
 * The tracking-health sweep (brief §9, M11).
 *
 * Loads facts, runs the pure checks, records what is new and closes what is no longer
 * true. The alert it raises says TRACKING — which is the exit check: "stopping a key
 * event raises a tracking alert within one sweep, not a 'users vanished' alert".
 */

export interface HealthResult {
  checked: number;
  recorded: number;
  resolved: number;
  alerted: number;
  findings: HealthFinding[];
}

/** How far back the duplicate and late checks look. */
const DOUBLE_SENT_HOURS = 24;
const LATE_HOURS = 24;

export async function checkTrackingHealth(db: ScopedDb, now: Date): Promise<HealthResult> {
  const rates = await eventRates(db, now, {
    recentHours: MISSING_EVENT_HOURS,
    baselineDays: BASELINE_DAYS,
  });
  const shapes = await propertyShapes(db);
  const duplicates = await doubleSentEvents(db, now, { hours: DOUBLE_SENT_HOURS });
  const late = await lateShare(db, now, { hours: LATE_HOURS, lateFlag: FLAG_LATE });
  const browser = await browserShare(db, now, {
    recentHours: MISSING_EVENT_HOURS,
    baselineDays: BASELINE_DAYS,
    browserSource: sourceToSmallInt('browser'),
    serverSource: sourceToSmallInt('server'),
  });

  const findings: HealthFinding[] = [
    ...missingEvents(rates, now),
    ...shapeDrift(shapes),
    // The source ids come out of SQL as numbers; naming them is this layer's job.
    ...doubleSent(
      duplicates.map((row) => ({ ...row, sources: row.sources.map(nameSource) })),
      now,
    ),
    ...lateEvents(
      late.map((row) => ({ ...row, source: nameSource(String(row.source)) })),
      now,
    ),
  ];

  const collapse = sourceShareCollapse(browser, now);
  if (collapse !== null) findings.push(collapse);

  let recorded = 0;
  for (const finding of findings) {
    const id = await recordTrackingFinding(db, finding);
    if (id === null) continue;
    recorded++;
  }

  /*
   * Closed before the alerts are raised, so a finding that came back to life in the
   * same sweep is not both resolved and alerted.
   */
  const resolved = await resolveTrackingFindings(db, findings, now);

  const alerted = await raiseTrackingAlerts(db, findings, now);
  return { checked: rates.length, recorded, resolved, alerted, findings };
}

function nameSource(value: string): string {
  const id = Number(value);
  try {
    return Number.isFinite(id) ? smallIntToSource(id) : value;
  } catch {
    return value;
  }
}

/**
 * A tracking finding in the alert feed.
 *
 * Unmasked and with no delivery row: these concern an event name, not a person, so
 * there is nothing to mask — and they go to the feed rather than to a channel because
 * a broken snippet is not a thing to interrupt someone's evening for. The weekly
 * report's part 5 is where they are meant to land.
 *
 * `dedupe_key` is what migration 0010 added: `alerts`' own unique key is
 * (project_id, leak_instance_id), and two NULLs are distinct in Postgres, so without
 * it every sweep would add another copy.
 */
async function raiseTrackingAlerts(
  db: ScopedDb,
  findings: readonly HealthFinding[],
  now: Date,
): Promise<number> {
  let alerted = 0;

  for (const finding of findings) {
    const written = await recordAlert(db, {
      leakInstanceId: null,
      dedupeKey: `${finding.kind}|${finding.subject}|${finding.episodeKey}`,
      leakType: finding.kind,
      subjectKind: 'tracking',
      subjectKey: 0,
      firedAt: finding.detectedAt,
      title: titleFor(finding.kind),
      says: finding.says,
      fields: [
        { label: 'What', value: finding.subject },
        { label: 'To do', value: finding.fix },
      ],
      masked: false,
      route: 'feed-only',
      because: 'Tracking health goes in your feed and your weekly report.',
      delivery: null,
    });
    if (written !== null) alerted++;
  }

  void now;
  return alerted;
}

const TITLES: Record<string, string> = {
  'missing-event': 'An event stopped arriving',
  'shape-drift': 'An event changed shape',
  'double-sent': 'An event is being sent twice',
  'late-events': 'Events are arriving late',
  'source-share': 'Browser events have dropped',
};

function titleFor(kind: string): string {
  return TITLES[kind] ?? 'Your tracking needs a look';
}

/** The worker's entry point. */
export async function runTrackingHealth(projectId: number, now: Date): Promise<HealthResult> {
  return withProject(projectId, (db) => checkTrackingHealth(db, now), { worker: true });
}

/** The dashboard's and the weekly report's view of what is wrong. */
export async function trackingProblems(db: ScopedDb): Promise<string[]> {
  const open = await openTrackingFindings(db);
  return open.map((finding) => finding.says);
}

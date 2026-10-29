import type { ScopedDb } from './scope.js';

/**
 * The facts the tracking-health checks run on (brief §9).
 *
 * All five reads take `now` and derive their windows from it, so a sweep can be
 * time-travelled in a test and no clock is read in SQL (CLAUDE.md rule 9 — there is a
 * lint rule covering this directory for exactly that reason).
 */

export interface EventRateRow {
  name: string;
  recent: number;
  baselinePerDay: number;
  lastSeenAt: Date | null;
  onChecklist: boolean;
}

/**
 * Per canonical event: how many arrived in the recent window, and the daily average
 * before it.
 *
 * Counted on `occurred_at` rather than `received_at`, because the question is whether
 * the founder's product is still emitting the event, not whether our queue is moving.
 * The baseline deliberately EXCLUDES the recent window — otherwise an outage drags
 * its own baseline down and the check quietly stops firing the longer it lasts.
 */
export async function eventRates(
  db: ScopedDb,
  now: Date,
  options: { recentHours: number; baselineDays: number },
): Promise<EventRateRow[]> {
  const recentFrom = new Date(now.getTime() - options.recentHours * 3_600_000);
  const baselineFrom = new Date(recentFrom.getTime() - options.baselineDays * 86_400_000);

  const rows = await db.query<{
    name: string;
    recent: string;
    baseline: string;
    last_seen_at: Date | null;
    on_checklist: boolean;
  }>(
    `SELECT n.canonical AS name,
            count(*) FILTER (WHERE e.occurred_at >= $2) AS recent,
            count(*) FILTER (WHERE e.occurred_at >= $3 AND e.occurred_at < $2) AS baseline,
            max(e.occurred_at) AS last_seen_at,
            bool_or(n.status = 'confirmed') AS on_checklist
       FROM event_names n
       JOIN events e ON e.project_id = n.project_id AND e.name_id = n.id
      WHERE n.project_id = $1
        AND n.canonical IS NOT NULL
        AND e.occurred_at >= $3
      GROUP BY n.canonical`,
    [db.projectId, recentFrom, baselineFrom],
  );

  return rows.map((row) => ({
    name: row.name,
    recent: Number(row.recent),
    baselinePerDay: Number(row.baseline) / options.baselineDays,
    lastSeenAt: row.last_seen_at,
    onChecklist: row.on_checklist,
  }));
}

export interface PropertyShapeRow {
  eventName: string;
  property: string;
  valueType: string;
  priorValueType: string | null;
  priorSeenCount: number;
  typeChangedAt: Date | null;
  firstSeenAt: Date;
  eventFirstSeenAt: Date;
  seenCount: number;
}

/** Every known property, with the type history migration 0010 added. */
export async function propertyShapes(db: ScopedDb): Promise<PropertyShapeRow[]> {
  const rows = await db.query<{
    event_name: string;
    property: string;
    value_type: string;
    prior_value_type: string | null;
    prior_seen_count: string;
    type_changed_at: Date | null;
    first_seen_at: Date;
    event_first_seen_at: Date;
    seen_count: string;
  }>(
    `SELECT coalesce(n.canonical, n.raw_name) AS event_name,
            p.property, p.value_type, p.prior_value_type, p.prior_seen_count,
            p.type_changed_at, p.first_seen_at,
            n.first_seen_at AS event_first_seen_at, p.seen_count
       FROM event_name_properties p
       JOIN event_names n ON n.project_id = p.project_id AND n.id = p.name_id
      WHERE p.project_id = $1`,
    [db.projectId],
  );

  return rows.map((row) => ({
    eventName: row.event_name,
    property: row.property,
    valueType: row.value_type,
    priorValueType: row.prior_value_type,
    priorSeenCount: Number(row.prior_seen_count),
    typeChangedAt: row.type_changed_at,
    firstSeenAt: row.first_seen_at,
    eventFirstSeenAt: row.event_first_seen_at,
    seenCount: Number(row.seen_count),
  }));
}

export interface DoubleSentRow {
  name: string;
  pairs: number;
  total: number;
  sources: string[];
}

/**
 * The same person, the same event, the same second, from two source paths.
 *
 * That is what a founder who added the server SDK without removing the browser call
 * produces. Deduping by `message_hash` cannot catch it — the two paths generate
 * different ids for what is really one action — so this is the only way to see it.
 *
 * `date_trunc('second')` and not a wider bucket: a second is tight enough that two
 * different people doing the same thing is rare, and the share threshold in the
 * engine handles the rest.
 */
export async function doubleSentEvents(
  db: ScopedDb,
  now: Date,
  options: { hours: number },
): Promise<DoubleSentRow[]> {
  const from = new Date(now.getTime() - options.hours * 3_600_000);

  const rows = await db.query<{
    name: string;
    pairs: string;
    total: string;
    sources: number[];
  }>(
    `WITH recent AS (
       SELECT e.name_id, e.user_key, e.source, e.occurred_at,
              coalesce(n.canonical, n.raw_name) AS name
         FROM events e
         JOIN event_names n ON n.project_id = e.project_id AND n.id = e.name_id
        WHERE e.project_id = $1 AND e.occurred_at >= $2 AND e.user_key IS NOT NULL
     ),
     per_second AS (
       SELECT name, user_key, date_trunc('second', occurred_at) AS second,
              count(DISTINCT source) AS source_count,
              array_agg(DISTINCT source) AS sources
         FROM recent
        GROUP BY name, user_key, second
     )
     SELECT r.name,
            count(*) FILTER (WHERE s.source_count > 1) AS pairs,
            count(*) AS total,
            coalesce(
              (SELECT array_agg(DISTINCT src)
                 FROM per_second p2, unnest(p2.sources) AS src
                WHERE p2.name = r.name AND p2.source_count > 1),
              ARRAY[]::int[]
            ) AS sources
       FROM recent r
       JOIN per_second s
         ON s.name = r.name AND s.user_key = r.user_key
        AND s.second = date_trunc('second', r.occurred_at)
      GROUP BY r.name
     HAVING count(*) FILTER (WHERE s.source_count > 1) > 0`,
    [db.projectId, from],
  );

  return rows.map((row) => ({
    name: row.name,
    pairs: Number(row.pairs),
    total: Number(row.total),
    // The source ids are translated to names by the caller, which owns that mapping.
    sources: row.sources.map(String),
  }));
}

export interface LateRow {
  source: number;
  late: number;
  total: number;
}

/** How many events from each source arrived after the fact (`FLAG_LATE`). */
export async function lateShare(
  db: ScopedDb,
  now: Date,
  options: { hours: number; lateFlag: number },
): Promise<LateRow[]> {
  const from = new Date(now.getTime() - options.hours * 3_600_000);

  const rows = await db.query<{ source: number; late: string; total: string }>(
    `SELECT source,
            count(*) FILTER (WHERE (flags & $3) <> 0) AS late,
            count(*) AS total
       FROM events
      WHERE project_id = $1 AND received_at >= $2
      GROUP BY source`,
    [db.projectId, from, options.lateFlag],
  );

  return rows.map((row) => ({
    source: row.source,
    late: Number(row.late),
    total: Number(row.total),
  }));
}

export interface BrowserShareRow {
  browserRecent: number;
  browserBaselinePerDay: number;
  serverRecent: number;
}

/**
 * Browser events now against their own history, with server events for contrast.
 *
 * The contrast is what makes the finding sayable: browser down while server is
 * steady is blocked tracking, and both down is a key or a host problem. Without the
 * second number we could only say "fewer events", which a founder cannot act on.
 */
export async function browserShare(
  db: ScopedDb,
  now: Date,
  options: {
    recentHours: number;
    baselineDays: number;
    browserSource: number;
    serverSource: number;
  },
): Promise<BrowserShareRow> {
  const recentFrom = new Date(now.getTime() - options.recentHours * 3_600_000);
  const baselineFrom = new Date(recentFrom.getTime() - options.baselineDays * 86_400_000);

  const row = await db.one<{
    browser_recent: string;
    browser_baseline: string;
    server_recent: string;
  }>(
    `SELECT count(*) FILTER (WHERE source = $4 AND occurred_at >= $2) AS browser_recent,
            count(*) FILTER (WHERE source = $4 AND occurred_at >= $3
                               AND occurred_at < $2) AS browser_baseline,
            count(*) FILTER (WHERE source = $5 AND occurred_at >= $2) AS server_recent
       FROM events
      WHERE project_id = $1 AND occurred_at >= $3`,
    [db.projectId, recentFrom, baselineFrom, options.browserSource, options.serverSource],
  );

  return {
    browserRecent: Number(row.browser_recent),
    browserBaselinePerDay: Number(row.browser_baseline) / options.baselineDays,
    serverRecent: Number(row.server_recent),
  };
}

// --- Recording the findings ------------------------------------------------

export interface TrackingFindingInput {
  kind: string;
  subject: string;
  episodeKey: string;
  detectedAt: Date;
  says: string;
  fix: string;
  details: Record<string, unknown>;
}

/**
 * Records a finding, once per episode.
 *
 * `ON CONFLICT DO NOTHING` against the unique key, the same shape as a leak: the
 * sweep is free to run as often as it likes and the index is the guarantee.
 */
export async function recordTrackingFinding(
  db: ScopedDb,
  finding: TrackingFindingInput,
): Promise<string | null> {
  const row = await db.maybeOne<{ id: string }>(
    `INSERT INTO tracking_findings
       (project_id, kind, subject, episode_key, detected_at, says, fix, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
     ON CONFLICT (project_id, kind, subject, episode_key) DO NOTHING
     RETURNING id`,
    [
      db.projectId,
      finding.kind,
      finding.subject,
      finding.episodeKey,
      finding.detectedAt,
      finding.says,
      finding.fix,
      JSON.stringify(finding.details),
    ],
  );
  return row?.id ?? null;
}

export interface TrackingFinding extends TrackingFindingInput {
  id: string;
  resolvedAt: Date | null;
}

export async function openTrackingFindings(db: ScopedDb): Promise<TrackingFinding[]> {
  const rows = await db.query<{
    id: string;
    kind: string;
    subject: string;
    episode_key: string;
    detected_at: Date;
    says: string;
    fix: string;
    details: Record<string, unknown>;
    resolved_at: Date | null;
  }>(
    `SELECT id, kind, subject, episode_key, detected_at, says, fix, details, resolved_at
       FROM tracking_findings
      WHERE project_id = $1 AND resolved_at IS NULL
      ORDER BY detected_at DESC`,
    [db.projectId],
  );

  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    subject: row.subject,
    episodeKey: row.episode_key,
    detectedAt: row.detected_at,
    says: row.says,
    fix: row.fix,
    details: row.details,
    resolvedAt: row.resolved_at,
  }));
}

/**
 * Closes the findings that are no longer true.
 *
 * Resolving by (kind, subject) and not by id: when `Signed Up` starts arriving again,
 * the finding that says it stopped is simply no longer true, whatever its episode key
 * was. A founder should not have to dismiss it by hand.
 */
export async function resolveTrackingFindings(
  db: ScopedDb,
  stillOpen: readonly { kind: string; subject: string; episodeKey: string }[],
  now: Date,
): Promise<number> {
  const keys = stillOpen.map(
    (finding) => `${finding.kind}|${finding.subject}|${finding.episodeKey}`,
  );

  return db.exec(
    `UPDATE tracking_findings SET resolved_at = $2
      WHERE project_id = $1 AND resolved_at IS NULL
        AND (kind || '|' || subject || '|' || episode_key) <> ALL($3::text[])`,
    [db.projectId, now, keys],
  );
}

import type { ScopedDb } from './scope.js';

/**
 * What the coverage checklist needs from the database (brief Appendix B).
 *
 * The checklist itself is a pure function in `@dripmetric/engine`; this is the one
 * query behind it. Kept apart so the rules can be tested without a database, and so
 * "which events are we actually getting?" is answered in exactly one place.
 */

export interface CoverageFacts {
  /** Canonical meanings with a confirmed mapping AND at least one event. */
  arriving: Set<string>;
  /** Raw names still waiting in the Inbox, counting toward nothing (decision 10). */
  unmappedCount: number;
}

export async function coverageFacts(db: ScopedDb): Promise<CoverageFacts> {
  /*
   * A mapping with no events behind it is not coverage.
   *
   * A founder can map "Thing Happened" to `Activated` and still not be sending it —
   * the mapping is a translation, not a promise. Counting it would make the
   * checklist claim a number the dashboard cannot show, which is the one thing the
   * checklist exists to prevent.
   */
  const rows = await db.query<{ canonical: string }>(
    `SELECT DISTINCT canonical
       FROM event_names
      WHERE project_id = $1
        AND canonical IS NOT NULL
        AND status = 'confirmed'
        AND event_count > 0`,
    [db.projectId],
  );

  const unmapped = await db.one<{ count: string }>(
    `SELECT count(*)::text AS count FROM event_names
      WHERE project_id = $1 AND status IN ('unmapped', 'suggested')`,
    [db.projectId],
  );

  return {
    arriving: new Set(rows.map((r) => r.canonical)),
    unmappedCount: Number(unmapped.count),
  };
}

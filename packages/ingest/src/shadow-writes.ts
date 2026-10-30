import { withShadow, type ShadowQuery } from '@dripmetric/db';

/**
 * Dual writes to the shadow, through the worker queue (settled decision 1, M13).
 *
 * "Dual writes through the worker" is the brief's own wording and it is the whole
 * design: the request path writes to the primary and queues a job, and THIS runs in
 * the worker. Ingest never waits for the shadow, so M13's exit check — killing the
 * shadow does not slow ingest — holds by construction rather than by care.
 *
 * What is copied is the data that cannot be rebuilt: raw events and the identities
 * they point at. Derived state is reproducible from those by the recompute job
 * (CLAUDE.md rule 10), so copying it would be work that buys nothing.
 */

export interface ShadowWriteBatch {
  projectId: number;
  /** The message hashes written to the primary, which is what gets copied. */
  messageHashes: string[];
}

export interface ShadowWriteResult {
  attempted: number;
  copied: number;
  /** Null when there is no shadow, or it did not answer. Never an error. */
  skippedBecause: string | null;
}

/**
 * Copies a batch of events, and the people they belong to, into the shadow.
 *
 * The rows are read back from the primary rather than passed through the queue. A job
 * payload carrying whole events would duplicate the schema in a JSON blob and drift
 * from it; message hashes are stable identifiers and the read is one indexed query.
 */
export async function copyBatchToShadow(
  readFromPrimary: (sql: string, params: readonly unknown[]) => Promise<Record<string, unknown>[]>,
  batch: ShadowWriteBatch,
): Promise<ShadowWriteResult> {
  if (batch.messageHashes.length === 0) {
    return { attempted: 0, copied: 0, skippedBecause: null };
  }

  const events = await readFromPrimary(
    `SELECT project_id, message_hash, name_id, user_key, anon_key, session_id,
            occurred_at, received_at, path_id, props, source, flags
       FROM events
      WHERE project_id = $1 AND message_hash = ANY($2::uuid[])`,
    [batch.projectId, batch.messageHashes],
  );

  if (events.length === 0) {
    /*
     * Nothing to copy is a success.
     *
     * The events were deduped, or retention already removed them. Either way the
     * shadow is not missing anything, and treating it as a failure would make the
     * reconciliation report a gap that does not exist.
     */
    return { attempted: 0, copied: 0, skippedBecause: null };
  }

  const userKeys = [...new Set(events.map((row) => row['user_key']).filter((key) => key !== null))];

  const people =
    userKeys.length === 0
      ? []
      : await readFromPrimary(
          `SELECT project_id, user_key, external_id, email_ciphertext, email_key_id,
                  email_type, name_traits_ciphertext, name_traits_key_id, traits, country,
                  signed_up_at, last_event_at, paid_at, trial_started_at, trial_ends_at,
                  internal, opted_out, deleted_at, account_id
             FROM end_users
            WHERE project_id = $1 AND user_key = ANY($2::int[])`,
          [batch.projectId, userKeys],
        );

  const written = await withShadow('copy-batch', async (query) => {
    /*
     * People before events, because the event references them.
     *
     * The shadow carries the same foreign keys as the primary — it has to, since the
     * point of it is being restorable — so the order matters here just as it does
     * there.
     */
    for (const person of people)
      await upsertRow(query, 'end_users', person, ['project_id', 'user_key']);
    for (const event of events)
      await upsertRow(query, 'events', event, ['project_id', 'message_hash']);
    return events.length;
  });

  return written === null
    ? { attempted: events.length, copied: 0, skippedBecause: 'the shadow did not answer' }
    : { attempted: events.length, copied: written, skippedBecause: null };
}

/**
 * One idempotent upsert, built from the row's own keys.
 *
 * Generated rather than written out because the alternative is a second copy of every
 * column list, which would drift from the migrations silently. The column names come
 * from the SELECT above, so a column added to `events` tomorrow is copied the day the
 * SELECT learns about it — and a column that is NOT in the SELECT is a deliberate
 * omission rather than an oversight.
 */
async function upsertRow(
  query: ShadowQuery,
  table: string,
  row: Record<string, unknown>,
  conflictKeys: string[],
): Promise<void> {
  const columns = Object.keys(row);
  const placeholders = columns.map((_column, index) => `$${index + 1}`);
  const updates = columns
    .filter((column) => !conflictKeys.includes(column))
    .map((column) => `${column} = EXCLUDED.${column}`);

  await query(
    `INSERT INTO ${table} (${columns.join(', ')})
     VALUES (${placeholders.join(', ')})
     ON CONFLICT (${conflictKeys.join(', ')}) DO UPDATE SET ${updates.join(', ')}`,
    columns.map((column) => row[column]),
  );
}

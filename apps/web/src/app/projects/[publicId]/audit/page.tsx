import { withOwnedProject } from '@/lib/project-access';

/**
 * The audit log (brief §10: "Audit log: settings changes, key events, reveals and
 * deletions").
 *
 * Read-only and append-only. A founder should be able to answer "who changed the list
 * price?" and "when was that name revealed?" themselves, and an auditor should be
 * able to see that reveals and deletions are recorded rather than taking our word for
 * it.
 *
 * It shows the actor's EMAIL, which is a founder's own teammate, not an end user —
 * the masking gate is about the people a founder tracks, not about the founder.
 */
export const dynamic = 'force-dynamic';

interface Entry {
  id: string;
  at: Date;
  action: string;
  subject: string | null;
  actor: string | null;
  details: Record<string, unknown>;
}

export default async function AuditPage({ params }: { params: Promise<{ publicId: string }> }) {
  const { publicId } = await params;

  const entries = await withOwnedProject(publicId, async (db) => {
    const rows = await db.query<{
      id: string;
      created_at: Date;
      action: string;
      subject: string | null;
      email: string | null;
      details: Record<string, unknown> | null;
    }>(
      `SELECT a.id, a.created_at, a.action, a.subject, fu.email, a.details
         FROM audit_log a
         LEFT JOIN founder_users fu ON fu.id = a.actor_user_id
        WHERE a.project_id = $1
        ORDER BY a.created_at DESC
        LIMIT 200`,
      [db.projectId],
    );

    return rows.map((row): Entry => ({
      id: row.id,
      at: row.created_at,
      action: row.action,
      subject: row.subject,
      actor: row.email,
      details: row.details ?? {},
    }));
  });

  return (
    <main style={{ maxWidth: 820, margin: '0 auto', padding: '32px 16px' }}>
      <h1 style={{ margin: '0 0 4px', fontSize: 22 }}>Audit log</h1>
      <p style={{ margin: '0 0 20px', color: '#6b7280', fontSize: 14 }}>
        Settings changes, key events, reveals and deletions. The most recent 200.
      </p>

      {entries.length === 0 && <p style={{ color: '#6b7280' }}>Nothing recorded yet.</p>}

      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr style={{ textAlign: 'left', color: '#6b7280' }}>
            <th style={{ padding: '6px 8px' }}>When</th>
            <th style={{ padding: '6px 8px' }}>Action</th>
            <th style={{ padding: '6px 8px' }}>Subject</th>
            <th style={{ padding: '6px 8px' }}>Who</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.id} style={{ borderTop: '1px solid #eceef2' }}>
              {/*
                The full timestamp, deliberately.

                Coarse times exist so a MASKED alert cannot be matched against the
                founder's logs. This table is the opposite job: it is the record of
                what was done to the project, and a record with "this week" in it
                would be useless for answering when something changed.
              */}
              <td style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>
                {entry.at.toISOString().replace('T', ' ').slice(0, 19)}
              </td>
              <td style={{ padding: '6px 8px' }}>
                <code>{entry.action}</code>
              </td>
              <td style={{ padding: '6px 8px' }}>{entry.subject ?? '—'}</td>
              <td style={{ padding: '6px 8px' }}>{entry.actor ?? 'system'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}

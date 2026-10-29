import { alertFeed, markFeedRead, unreadAlertCount } from '@dripmetric/db';
import { withOwnedProject } from '@/lib/project-access';
import { UnreadBadge } from './badge';

/**
 * The in-app feed (brief §9: "always to the in-app feed").
 *
 * Every alert is here whatever happened to the channel post, and each row says which
 * it was: sent, waiting for the morning, feed-only because the day's tenth had
 * already gone out. That last part is the point of the `because` column — a founder
 * who sees nine alerts in Slack and twenty here should be able to tell why without
 * asking.
 */
export const dynamic = 'force-dynamic';

export default async function AlertsPage({
  params,
  searchParams,
}: {
  params: Promise<{ publicId: string }>;
  searchParams: Promise<{ read?: string }>;
}) {
  const { publicId } = await params;
  const { read } = await searchParams;
  const now = new Date();

  const { feed, unread, projectName } = await withOwnedProject(publicId, async (db, project) => {
    // `?read=1` is a plain link rather than a button: marking a feed read is not
    // something worth a form, and a link survives JavaScript being off.
    if (read === '1') await markFeedRead(db, now);
    return {
      feed: await alertFeed(db, now, { limit: 100 }),
      unread: await unreadAlertCount(db),
      projectName: project.name,
    };
  });

  return (
    <main style={{ maxWidth: 820, margin: '0 auto', padding: '32px 16px' }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
        <h1 style={{ margin: 0, fontSize: 22 }}>Alerts</h1>
        <UnreadBadge publicId={publicId} initial={unread} />
      </header>
      <p style={{ margin: '0 0 20px', color: '#6b7280', fontSize: 14 }}>
        {projectName} · every leak lands here, whether or not it reached your chat app.
        {unread > 0 && (
          <>
            {' '}
            <a href={`/projects/${publicId}/alerts?read=1`}>Mark all read</a>
          </>
        )}
      </p>

      {feed.length === 0 && (
        <p style={{ color: '#6b7280' }}>
          Nothing yet. Alerts appear here as soon as a leak is found.
        </p>
      )}

      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {feed.map((alert) => (
          <li
            key={alert.id}
            style={{
              borderLeft: `3px solid ${alert.read ? '#eceef2' : '#d9433f'}`,
              background: '#fff',
              borderRadius: 8,
              padding: '12px 14px',
              marginBottom: 10,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
              <strong style={{ fontSize: 15 }}>{alert.title}</strong>
              <span style={{ color: '#6b7280', fontSize: 13, whiteSpace: 'nowrap' }}>
                {alert.when}
              </span>
            </div>
            <p style={{ margin: '6px 0 8px', fontSize: 14, lineHeight: 1.5 }}>{alert.says}</p>

            <dl
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
                gap: '4px 12px',
                margin: '0 0 8px',
                fontSize: 13,
              }}
            >
              {alert.fields.map((field) => (
                <div key={field.label}>
                  <dt style={{ color: '#6b7280' }}>{field.label}</dt>
                  <dd style={{ margin: 0 }}>{field.value}</dd>
                </div>
              ))}
            </dl>

            <p style={{ margin: 0, fontSize: 12, color: '#6b7280' }}>
              {deliveryLine(alert.delivery, alert.route)} {alert.because}
            </p>
          </li>
        ))}
      </ul>
    </main>
  );
}

/** What became of the channel post, in the founder's words. */
function deliveryLine(
  delivery: { channel: string; state: string; attempts: number; lastError: string | null } | null,
  route: string,
): string {
  if (delivery === null) return route === 'feed-only' ? 'Not sent to a channel.' : '';
  switch (delivery.state) {
    case 'sent':
      return `Sent to ${delivery.channel}.`;
    case 'held':
      return `Waiting for the morning, then ${delivery.channel}.`;
    case 'pending':
      return delivery.attempts > 0
        ? `Retrying ${delivery.channel} (attempt ${delivery.attempts + 1}).`
        : `Queued for ${delivery.channel}.`;
    case 'failed':
      return `Could not reach ${delivery.channel} after ${delivery.attempts} tries${
        delivery.lastError === null ? '' : `: ${delivery.lastError}`
      }.`;
    case 'skipped':
      return `Not sent to ${delivery.channel}.`;
    default:
      return '';
  }
}

import Link from 'next/link';
import { loadDashboard } from '@/lib/dashboard';
import { withOwnedProject } from '@/lib/project-access';
import {
  ChangesModule,
  CheckoutModule,
  FunnelModule,
  IntentModule,
  LeakSummary,
  QuietPayersModule,
  RetentionModule,
  TrackingHealthModule,
} from './modules';

export const dynamic = 'force-dynamic';

/**
 * The dashboard: eight modules (brief §9).
 *
 * One await for the lot, cached 60 seconds. Masking is not decided here — the rows
 * arrive already serialized by the data-access layer, so this page renders whatever
 * the project's plan allows and could not leak a name if it tried.
 */
export default async function DashboardPage({ params }: { params: Promise<{ publicId: string }> }) {
  const { publicId } = await params;
  const data = await withOwnedProject(publicId, (db) => loadDashboard(db, new Date()));

  const nothingYet = data.intent.users === 0 && data.funnel.steps.length === 0;

  return (
    <>
      <h1>{data.project.name}</h1>
      <p className="lede">
        On the {data.plan.planCode} plan. {data.reveals.note}{' '}
        <Link href={`/projects/${publicId}/settings`}>Settings</Link> ·{' '}
        <Link href={`/projects/${publicId}/setup`}>Setup</Link> ·{' '}
        <Link href={`/projects/${publicId}/inbox`}>Inbox</Link>
      </p>

      {nothingYet ? (
        <div className="card">
          <p>
            Nothing has arrived yet. Once your first events land, this page fills in on its own.
          </p>
          <p className="note">
            <Link href={`/projects/${publicId}`}>Your keys and the snippet</Link> are on the project
            page.
          </p>
        </div>
      ) : (
        <>
          {data.setup.completedAt === null && (
            <p className="warn">
              {data.setup.confirmedCount} of 5 setup facts confirmed. Everything below works already
              — the facts are what let it explain itself.{' '}
              <Link href={`/projects/${publicId}/setup`}>Finish setup</Link>.
            </p>
          )}

          <LeakSummary data={data} />
          <FunnelModule data={data} publicId={publicId} />
          <IntentModule data={data} publicId={publicId} />
          <CheckoutModule data={data} publicId={publicId} />
          <RetentionModule data={data} />
          <QuietPayersModule data={data} publicId={publicId} />
          <TrackingHealthModule data={data} publicId={publicId} />
          <ChangesModule data={data} publicId={publicId} />
        </>
      )}

      <p className="note">
        Computed at {data.computedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC, and cached
        for a minute. We keep {data.retentionDays} days of raw events; the daily summaries are kept
        for good.
      </p>
    </>
  );
}

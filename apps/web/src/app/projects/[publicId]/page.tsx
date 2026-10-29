import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import {
  displayKey,
  listKeys,
  withProjectByPublicId,
  currentProject,
  entitlements,
  limitOf,
} from '@dripmetric/db';
import { currentUser, userOwnsProject } from '@/lib/auth';
import { webEnv } from '@/lib/env';

export const dynamic = 'force-dynamic';

/**
 * The project page. At M0 it shows the keys and the snippet; the eight dashboard
 * modules arrive at M9.
 */
export default async function ProjectPage({ params }: { params: Promise<{ publicId: string }> }) {
  const user = await currentUser();
  if (!user) redirect('/login');

  const { publicId } = await params;

  const view = await withProjectByPublicId(publicId, async (db) => {
    const project = await currentProject(db);
    const keys = await listKeys(db);
    const plan = await entitlements(db);
    return { project, keys, plan };
  });

  if (!view) notFound();
  if (!(await userOwnsProject(user.id, view.project.id))) notFound();

  const publishableLive = view.keys.find((k) => k.kind === 'publishable' && k.mode === 'live');
  const retentionDays = limitOf(view.plan, 'retention_days');

  return (
    <>
      <h1>{view.project.name}</h1>
      <p className="lede">
        On the {view.plan.planCode === 'free' ? 'free' : view.plan.planCode} plan. We keep{' '}
        {retentionDays} days of raw events; daily summaries are kept for good.
      </p>

      <p>
        <Link href={`/projects/${publicId}/dashboard`}>Dashboard</Link> ·{' '}
        <Link href={`/projects/${publicId}/setup`}>Set up your product</Link> ·{' '}
        <Link href={`/projects/${publicId}/inbox`}>Inbox</Link> ·{' '}
        <Link href={`/projects/${publicId}/settings`}>Settings</Link>
      </p>

      <h2>Your keys</h2>
      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Key</th>
              <th>Where it goes</th>
              <th>Value</th>
            </tr>
          </thead>
          <tbody>
            {view.keys.map((k) => (
              <tr key={k.id}>
                <td>
                  {k.kind === 'publishable' ? 'Publishable' : 'Secret'} ({k.mode})
                </td>
                <td className="note">
                  {k.kind === 'publishable' ? 'Your website' : 'Your server only'}
                </td>
                <td>
                  <code>{k.token ?? displayKey(`sk_${k.mode}_xxxxxxxxxxxxxxxx${k.lastFour}`)}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="note">
          Secret keys are stored hashed, so we can only show you the last four characters. If you
          have lost one, rotate it.
        </p>
      </div>

      <h2>Your snippet</h2>
      <div className="card">
        <p className="note">Put this in your page shell, once.</p>
        <code className="key">{`dripmetric.init('${publishableLive?.token ?? 'pk_live_…'}')`}</code>
        <p className="note">
          Nothing is stored on a visitor&rsquo;s device and nothing is sent until they consent,
          because this project has &ldquo;consent required&rdquo; switched{' '}
          {view.project.settings.consentRequired ? 'on' : 'off'}.
        </p>
      </div>

      <h2>Waiting for your first event</h2>
      <div className="card">
        <p>Nothing has arrived yet. Send one from anywhere to check the connection:</p>
        <code className="key">
          {`curl ${webEnv().APP_URL}/v1/batch -H "Authorization: Bearer $DRIPMETRIC_SECRET_KEY" -H "Content-Type: application/json" -d '{"batch":[{"type":"track","messageId":"test-1","userId":"user_123","event":"Signed Up"}]}'`}
        </code>
      </div>
    </>
  );
}

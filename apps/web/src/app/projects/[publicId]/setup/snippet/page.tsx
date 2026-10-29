import {
  generateSnippet,
  librariesFor,
  SNIPPET_STACKS,
  type SnippetLibrary,
  type SnippetStack,
  type SnippetStep,
} from '@dripmetric/engine';
import { loadStepDefinitions } from '@dripmetric/ingest';
import { PAID_EVENT } from '@dripmetric/engine';
import { withOwnedProject } from '@/lib/project-access';
import { webEnv } from '@/lib/env';

/**
 * The AI-coder prompt generator (brief §9).
 *
 * The founder picks a stack and a library; the page renders the code and the prompt
 * from the SAME engine function the tests exercise, using their own funnel steps.
 *
 * The secret key is a placeholder, never the real one. A key printed on a page ends
 * up in a screenshot, a support ticket and a browser's history — and this page can be
 * reloaded, whereas the real secret was readable exactly once at creation.
 */
export const dynamic = 'force-dynamic';

export default async function SnippetPage({
  params,
  searchParams,
}: {
  params: Promise<{ publicId: string }>;
  searchParams: Promise<{ stack?: string; library?: string }>;
}) {
  const { publicId } = await params;
  const query = await searchParams;

  const stack: SnippetStack = (SNIPPET_STACKS as readonly string[]).includes(query.stack ?? '')
    ? (query.stack as SnippetStack)
    : 'next-app-router';
  const allowed = librariesFor(stack);
  const library: SnippetLibrary = allowed.includes((query.library ?? '') as SnippetLibrary)
    ? (query.library as SnippetLibrary)
    : (allowed[0] ?? 'http');

  const { steps, publishableKey, paidEvent } = await withOwnedProject(
    publicId,
    async (db, project) => {
      const definitions = await loadStepDefinitions(db);
      const key = await db.maybeOne<{ token: string }>(
        `SELECT token FROM api_keys
          WHERE project_id = $1 AND kind = 'publishable' AND mode = 'live'
            AND revoked_at IS NULL
          ORDER BY created_at LIMIT 1`,
        [db.projectId],
      );
      const paid = await db.maybeOne<{ canonical: string }>(
        `SELECT canonical FROM event_names
          WHERE project_id = $1 AND canonical = $2 AND status = 'confirmed' LIMIT 1`,
        [db.projectId, PAID_EVENT],
      );

      return {
        steps: definitions.map((step): SnippetStep => ({
          label: step.label,
          eventName: step.eventName,
          position: step.position,
        })),
        publishableKey: key?.token ?? 'pk_live_your_key',
        paidEvent: paid?.canonical ?? null,
        projectName: project.name,
      };
    },
  );

  const generated = generateSnippet({
    stack,
    library,
    host: webEnv().APP_URL,
    publishableKey,
    secretKeyPlaceholder: 'YOUR_SECRET_KEY',
    steps,
    paidEvent,
  });

  return (
    <main style={{ maxWidth: 860, margin: '0 auto', padding: '32px 16px' }}>
      <h1 style={{ margin: '0 0 4px', fontSize: 22 }}>Your tracking code</h1>
      <p style={{ margin: '0 0 20px', color: '#6b7280', fontSize: 14 }}>
        Pick your stack. The prompt below is written to be pasted into an AI coding agent — it
        carries your own funnel steps and the exact event names.
      </p>

      <form style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
        <label style={{ fontSize: 13 }}>
          Stack{' '}
          <select name="stack" defaultValue={stack} style={{ padding: 4 }}>
            {SNIPPET_STACKS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        <label style={{ fontSize: 13 }}>
          Library{' '}
          <select name="library" defaultValue={library} style={{ padding: 4 }}>
            {allowed.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" style={{ padding: '4px 12px' }}>
          Show
        </button>
      </form>

      {steps.length === 0 && (
        <p
          style={{
            background: '#fff8e1',
            padding: '10px 12px',
            borderRadius: 8,
            fontSize: 14,
          }}
        >
          You have not confirmed your funnel yet, so this uses the default event names. Confirm your
          steps first and this page will use your own labels.
        </p>
      )}

      {generated.notes.length > 0 && (
        <ul style={{ fontSize: 13, color: '#6b7280', paddingLeft: 18 }}>
          {generated.notes.map((note) => (
            <li key={note} style={{ marginBottom: 4 }}>
              {note}
            </li>
          ))}
        </ul>
      )}

      {generated.install !== null && (
        <>
          <h2 style={{ fontSize: 15, marginBottom: 4 }}>Install</h2>
          <pre style={codeStyle}>{generated.install}</pre>
        </>
      )}

      <h2 style={{ fontSize: 15, marginBottom: 4 }}>The prompt</h2>
      <p style={{ margin: '0 0 6px', fontSize: 13, color: '#6b7280' }}>
        Paste this whole thing into your coding agent.
      </p>
      <pre style={codeStyle}>{generated.prompt}</pre>

      <h2 style={{ fontSize: 15, marginBottom: 4 }}>Or the code on its own</h2>
      <pre style={codeStyle}>{generated.code}</pre>

      <p style={{ fontSize: 13, color: '#6b7280' }}>
        Your secret key is shown as <code>YOUR_SECRET_KEY</code> on purpose: it was readable once,
        when the project was made. Put it in an environment variable. If you have lost it, rotate it
        in settings.
      </p>
    </main>
  );
}

const codeStyle = {
  background: '#1f2430',
  color: '#e6e8ee',
  padding: '12px 14px',
  borderRadius: 8,
  fontSize: 12.5,
  lineHeight: 1.5,
  overflowX: 'auto' as const,
  whiteSpace: 'pre-wrap' as const,
  marginTop: 0,
};

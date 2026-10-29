import Link from 'next/link';
import { dictionary, inbox, setupState, type DictionaryEntry } from '@dripmetric/db';
import { CANONICAL_MEANINGS } from '@dripmetric/catalog';
import { withOwnedProject } from '@/lib/project-access';
import { suggestionsConfigured } from '@/lib/anthropic';
import { confirmMappingAction, ignoreNameAction, suggestMappingsAction } from '../actions';

export const dynamic = 'force-dynamic';

/**
 * The Inbox (brief §7, settled decision 10).
 *
 * "Unmapped events are stored and visible in the Inbox, but count toward nothing
 * until mapped." The screen exists so that sentence is visible rather than silent:
 * here are the names we do not understand, here is what we would guess and why, and
 * nothing you see elsewhere is affected until you say so.
 */
export default async function InboxPage({ params }: { params: Promise<{ publicId: string }> }) {
  const { publicId } = await params;

  const view = await withOwnedProject(publicId, async (db, project) => ({
    project,
    waiting: await inbox(db),
    all: await dictionary(db),
    setup: await setupState(db),
  }));

  const decided = view.all.filter((e) => e.status === 'confirmed' || e.status === 'ignored');
  const canSuggest = suggestionsConfigured();

  return (
    <>
      <h1>Inbox</h1>
      <p className="lede">
        {view.waiting.length === 0
          ? 'Nothing is waiting. Every name you send has a meaning.'
          : `${view.waiting.length} name${view.waiting.length === 1 ? '' : 's'} we do not understand yet. They are stored, and they count toward nothing until you map them.`}
      </p>

      {view.waiting.length > 0 && (
        <div className="card">
          {canSuggest ? (
            <form action={suggestMappingsAction}>
              <input type="hidden" name="publicId" value={publicId} />
              <p className="note">
                We can read the names, their property keys and where they fall in a person&rsquo;s
                sequence, and suggest what each one means. No one&rsquo;s email, name, id or
                anything that looks personal is ever part of that — only the shape.
              </p>
              <button type="submit">Suggest meanings</button>
            </form>
          ) : (
            <p className="note">
              Automatic suggestions are switched off here. Map the names by hand below — it is the
              same screen either way.
            </p>
          )}
          {view.setup.suggestionsRunAt && (
            <p className="note">
              Last run {view.setup.suggestionsRunAt.toISOString().slice(0, 16).replace('T', ' ')}{' '}
              UTC
              {view.setup.suggestionsInputTokens !== null &&
                ` · ${view.setup.suggestionsInputTokens} in, ${view.setup.suggestionsOutputTokens ?? 0} out`}
              .
            </p>
          )}
        </div>
      )}

      {view.waiting.map((entry) => (
        <WaitingCard key={entry.rawName} entry={entry} publicId={publicId} />
      ))}

      <h2>What your names mean</h2>
      {decided.length === 0 ? (
        <p className="note">Nothing mapped yet.</p>
      ) : (
        <div className="card">
          <table>
            <thead>
              <tr>
                <th>Your name</th>
                <th>Means</th>
                <th>Events</th>
              </tr>
            </thead>
            <tbody>
              {decided.map((entry) => (
                <tr key={entry.rawName}>
                  <td>
                    <code>{entry.rawName}</code>
                  </td>
                  <td>
                    {entry.status === 'ignored' ? (
                      <span className="note">ignored</span>
                    ) : (
                      (entry.canonical ?? <span className="note">nothing</span>)
                    )}
                  </td>
                  <td>{entry.eventCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="note">
            Changing one of these rebuilds your history, so your numbers stay in one piece.
          </p>
        </div>
      )}

      <p className="note">
        <Link href={`/projects/${publicId}/setup`}>Back to setup</Link>
      </p>
    </>
  );
}

function WaitingCard({ entry, publicId }: { entry: DictionaryEntry; publicId: string }) {
  return (
    <div className="card">
      <h2 style={{ margin: '0 0 0.35rem' }}>
        <code>{entry.rawName}</code>
      </h2>
      <p className="note">
        {entry.eventCount} event{entry.eventCount === 1 ? '' : 's'} from {entry.distinctUsers}{' '}
        {entry.distinctUsers === 1 ? 'person' : 'people'}
        {entry.medianSequencePosition !== null &&
          `, usually their ${ordinal(Math.round(entry.medianSequencePosition))} event`}
        {entry.properties.length > 0 && (
          <> · carries {entry.properties.map((p) => p.property).join(', ')}</>
        )}
      </p>

      {entry.status === 'suggested' && entry.reason && (
        <p>
          We think this means <strong>{entry.canonical ?? 'nothing on our list'}</strong>.{' '}
          <span className="note">
            {entry.reason} ({entry.confidence} confidence)
          </span>
        </p>
      )}

      <form action={confirmMappingAction}>
        <input type="hidden" name="publicId" value={publicId} />
        <input type="hidden" name="rawName" value={entry.rawName} />
        <label htmlFor={`canonical-${entry.rawName}`}>This means</label>
        <select
          id={`canonical-${entry.rawName}`}
          name="canonical"
          defaultValue={entry.canonical ?? ''}
        >
          <option value="">nothing on our list</option>
          {CANONICAL_MEANINGS.map((meaning) => (
            <option key={meaning} value={meaning}>
              {meaning}
            </option>
          ))}
        </select>
        <button type="submit">Save</button>
      </form>

      <form action={ignoreNameAction}>
        <input type="hidden" name="publicId" value={publicId} />
        <input type="hidden" name="rawName" value={entry.rawName} />
        <button type="submit" className="secondary">
          It&rsquo;s noise, ignore it
        </button>
      </form>
    </div>
  );
}

function ordinal(n: number): string {
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  return `${n}${suffix}`;
}

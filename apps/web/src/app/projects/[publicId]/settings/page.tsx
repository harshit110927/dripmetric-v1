import Link from 'next/link';
import { entitlements, listChanges, revealAllowanceNote, revealState } from '@dripmetric/db';
import { withOwnedProject } from '@/lib/project-access';
import { markChangeAction, saveSettingsAction, unfreezeAction } from '../actions';

export const dynamic = 'force-dynamic';

/**
 * The settings page (brief §9).
 *
 * Every field here is something the engines read, and each one says what it changes
 * rather than what it is called — a founder should never have to guess what
 * "didntPayWindowDays" does to their numbers.
 */
export default async function SettingsPage({ params }: { params: Promise<{ publicId: string }> }) {
  const { publicId } = await params;

  const view = await withOwnedProject(publicId, async (db, project) => ({
    project,
    plan: await entitlements(db),
    reveals: await revealState(db),
    changes: await listChanges(db),
  }));

  const s = view.project.settings;
  const frozen = view.changes.some((change) => change.result === null);

  return (
    <>
      <h1>Settings</h1>
      <p className="lede">
        <Link href={`/projects/${publicId}/dashboard`}>Back to the dashboard</Link>
      </p>

      <form action={saveSettingsAction}>
        <input type="hidden" name="publicId" value={publicId} />

        <h2>Your product</h2>
        <div className="card">
          <label htmlFor="productDescription">One line about what it does</label>
          <input
            id="productDescription"
            name="productDescription"
            type="text"
            defaultValue={s.productDescription}
            placeholder="Invoicing for freelancers"
          />
          <p className="note">
            Used when we suggest what your event names mean. It never leaves our servers with
            anyone&rsquo;s data attached.
          </p>

          <label htmlFor="productKind">What kind of product is it</label>
          <select id="productKind" name="productKind" defaultValue={s.productKind}>
            <option value="self-serve">One person signs up and uses it</option>
            <option value="team">A team uses it together</option>
            <option value="developer">Developers use it</option>
          </select>
          <p className="note">
            Changes which signals count. &ldquo;Signed up on a desktop&rdquo; is a buying signal for
            a team product and noise for a phone-first one.
          </p>

          <label>
            <input type="checkbox" name="mobileFirst" defaultChecked={s.mobileFirst} /> Most of our
            users are on phones
          </label>
          <p className="note">Turns off the desktop-at-signup signal.</p>
        </div>

        <h2>Your own team</h2>
        <div className="card">
          <label htmlFor="internalDomains">Your email domains</label>
          <input
            id="internalDomains"
            name="internalDomains"
            type="text"
            defaultValue={s.internalDomains.join(', ')}
            placeholder="acme.com, acme-internal.com"
          />
          <label htmlFor="internalEmails">And any individual addresses</label>
          <input
            id="internalEmails"
            name="internalEmails"
            type="text"
            defaultValue={s.internalEmails.join(', ')}
          />
          <p className="note">
            Anyone on this list is kept out of every number, and anything already stored for them is
            deleted.
          </p>
        </div>

        <h2>How we count</h2>
        <div className="card">
          <label htmlFor="didntPayWindowDays">
            Days to wait before someone counts as &ldquo;looked ready and didn&rsquo;t pay&rdquo;
          </label>
          <input
            id="didntPayWindowDays"
            name="didntPayWindowDays"
            type="text"
            inputMode="numeric"
            defaultValue={String(s.didntPayWindowDays)}
          />
          <p className="note">
            Currently {s.didntPayWindowDays} days. Someone inside the window is shown separately, as
            &ldquo;still time&rdquo;.
          </p>

          <label htmlFor="brandTerms">
            Your product&rsquo;s name, and anything people search for it by
          </label>
          <input
            id="brandTerms"
            name="brandTerms"
            type="text"
            defaultValue={s.brandTerms.join(', ')}
          />
          <p className="note">
            Matched against your own campaign tags. Search engines hide the search terms, so this is
            the only way we can tell someone came looking for you by name.
          </p>
        </div>

        <h2>Privacy and keys</h2>
        <div className="card">
          <label>
            <input type="checkbox" name="consentRequired" defaultChecked={s.consentRequired} />{' '}
            Store nothing on a visitor&rsquo;s device until they consent
          </label>
          <p className="note">
            On by default. With it on, the snippet keeps nothing and sends nothing until you call
            consent.
          </p>

          <label htmlFor="allowedOrigins">Websites your publishable key may be used from</label>
          <input
            id="allowedOrigins"
            name="allowedOrigins"
            type="text"
            defaultValue={s.allowedOrigins.join(', ')}
            placeholder="https://acme.com"
          />

          <label htmlFor="revealAllowance">How many names you may reveal</label>
          <input
            id="revealAllowance"
            name="revealAllowance"
            type="text"
            inputMode="numeric"
            defaultValue={String(s.revealAllowance)}
          />
          <p className="note">{revealAllowanceNote(view.reveals, view.plan)}</p>
        </div>

        <h2>Alerts</h2>
        <div className="card">
          <label htmlFor="alertChannel">Where instant alerts go</label>
          <select id="alertChannel" name="alertChannel" defaultValue={s.alertChannel}>
            <option value="none">Nowhere yet — just the in-app feed</option>
            <option value="slack">Slack</option>
            <option value="discord">Discord</option>
            <option value="email-digest">One email a day</option>
          </select>
          <p className="note">
            At most 10 instant alerts a day; the rest wait in the feed and the weekly report.
          </p>
        </div>

        <button type="submit">Save settings</button>
      </form>

      <h2>Mark a change</h2>
      <div className="card">
        <p className="note">
          When you ship something, mark it. We freeze the thresholds at what they are now, so the
          before and after are measured against the same bar rather than a moving one.
        </p>
        <form action={markChangeAction}>
          <input type="hidden" name="publicId" value={publicId} />
          <label htmlFor="note">What did you change?</label>
          <input
            id="note"
            name="note"
            type="text"
            placeholder="Cut the bank step down to one screen"
          />
          <label htmlFor="happenedAt">When did it go live?</label>
          <input id="happenedAt" name="happenedAt" type="text" placeholder="2026-10-29" />
          <button type="submit">Mark it</button>
        </form>

        {frozen && (
          <form action={unfreezeAction}>
            <input type="hidden" name="publicId" value={publicId} />
            <p className="note">
              Your thresholds are frozen at a marked change. Unfreeze them when the comparison has
              served its purpose, and they will start tracking your product again.
            </p>
            <button type="submit" className="secondary">
              Unfreeze thresholds
            </button>
          </form>
        )}
      </div>
    </>
  );
}

import Link from 'next/link';
import { coverageFacts, setupState, type FactState } from '@dripmetric/db';
import { coverage, type Coverage } from '@dripmetric/engine';
import { withOwnedProject } from '@/lib/project-access';
import { confirmFactAction, saveMoneyFactsAction, unconfirmFactAction } from '../actions';

export const dynamic = 'force-dynamic';

/**
 * Setup: the five product facts, and the coverage checklist (brief §2 and §7).
 *
 * The screen says what we know, where each answer came from, and what is still
 * missing — and it never pretends setup is a gate. Everything that can be shown is
 * shown before setup is finished; the only thing missing is the explanation.
 */
export default async function SetupPage({ params }: { params: Promise<{ publicId: string }> }) {
  const { publicId } = await params;

  const view = await withOwnedProject(publicId, async (db, project) => ({
    project,
    setup: await setupState(db),
    coverage: coverage(await coverageFacts(db)),
  }));

  const { setup } = view;

  return (
    <>
      <h1>Set up {view.project.name}</h1>
      <p className="lede">
        {setup.completedAt
          ? 'All five facts are confirmed. Change any of them whenever your product changes.'
          : `${setup.confirmedCount} of 5 confirmed. Your dashboard works already — these five facts are what let it explain itself.`}
      </p>

      {!setup.paidEventArriving && (
        <p className="warn">
          We are not getting a paid event yet, so we can show you where people drop out but not what
          it costs you. Send <code>Subscription Started</code> from your server, or{' '}
          <Link href={`/projects/${publicId}/inbox`}>map one of your own events to it</Link>.
        </p>
      )}

      {setup.facts.map((fact) => (
        <FactCard key={fact.fact} fact={fact} publicId={publicId} />
      ))}

      <h2>Price and trial</h2>
      <div className="card">
        <form action={saveMoneyFactsAction}>
          <input type="hidden" name="publicId" value={publicId} />
          <label htmlFor="price">What does it cost?</label>
          <input
            id="price"
            name="price"
            type="text"
            inputMode="decimal"
            defaultValue={
              view.project.settings.listPriceAmount === null
                ? ''
                : (view.project.settings.listPriceAmount / 100).toFixed(2)
            }
            placeholder="29.00"
          />
          <p className="note">
            Per {view.project.settings.listPriceInterval}, in{' '}
            {view.project.settings.listPriceCurrency.toUpperCase()}. Every leak is shown in money,
            and this is where the money comes from.
          </p>

          <label htmlFor="currency">Currency</label>
          <input
            id="currency"
            name="currency"
            type="text"
            maxLength={3}
            defaultValue={view.project.settings.listPriceCurrency}
          />

          <label htmlFor="interval">Billed</label>
          <select
            id="interval"
            name="interval"
            defaultValue={view.project.settings.listPriceInterval}
          >
            <option value="month">every month</option>
            <option value="year">every year</option>
          </select>

          <label htmlFor="trialDays">Trial length in days</label>
          <input
            id="trialDays"
            name="trialDays"
            type="text"
            inputMode="numeric"
            defaultValue={view.project.settings.trialDays ?? ''}
            placeholder="leave empty for no trial"
          />

          <button type="submit">Save</button>
        </form>
      </div>

      <CoverageChecklist coverage={view.coverage} publicId={publicId} />
    </>
  );
}

function FactCard({ fact, publicId }: { fact: FactState; publicId: string }) {
  const confirmed = fact.confirmedAt !== null;

  return (
    <div className="card">
      <h2 style={{ margin: '0 0 0.35rem' }}>{fact.question}</h2>
      <p>
        {fact.value === null ? (
          <span className="note">Nothing to show yet.</span>
        ) : (
          <strong>{fact.value}</strong>
        )}{' '}
        <span className="note">({originNote(fact)})</span>
      </p>
      <p className="note">{fact.why}</p>

      {confirmed ? (
        <form action={unconfirmFactAction}>
          <input type="hidden" name="publicId" value={publicId} />
          <input type="hidden" name="fact" value={fact.fact} />
          <button type="submit" className="secondary">
            Change this
          </button>
        </form>
      ) : fact.ready ? (
        <form action={confirmFactAction}>
          <input type="hidden" name="publicId" value={publicId} />
          <input type="hidden" name="fact" value={fact.fact} />
          <button type="submit">That&rsquo;s right</button>
        </form>
      ) : (
        <p className="note">{fact.blockedBecause}</p>
      )}
    </div>
  );
}

/** Where the answer came from. A default we guessed is not a fact they checked. */
function originNote(fact: FactState): string {
  switch (fact.origin) {
    case 'founder':
      return 'you confirmed this';
    case 'observed':
      return 'from your events — check it';
    case 'default':
      return 'our assumption — check it';
    case 'missing':
      return 'not set';
  }
}

function CoverageChecklist({
  coverage: result,
  publicId,
}: {
  coverage: Coverage;
  publicId: string;
}) {
  return (
    <>
      <h2>What we are getting</h2>
      <div className="card">
        <p>
          <strong>{result.score}%</strong> of the events we can use.
          {result.unmappedCount > 0 && (
            <>
              {' '}
              <Link href={`/projects/${publicId}/inbox`}>
                {result.unmappedCount} name{result.unmappedCount === 1 ? '' : 's'} waiting in the
                Inbox
              </Link>
              , counting toward nothing until you map them.
            </>
          )}
        </p>

        {result.switchedOff.length === 0 ? (
          <p className="note">Nothing is switched off. Every module has what it needs.</p>
        ) : (
          <>
            <p className="note">These are off until the events arrive:</p>
            <table>
              <thead>
                <tr>
                  <th>What is off</th>
                  <th>Why</th>
                </tr>
              </thead>
              <tbody>
                {result.switchedOff.map((off) => (
                  <tr key={off.metric}>
                    <td>{off.metric}</td>
                    <td className="note">{off.because}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>

      {result.tiers.map((tier) => (
        <div className="card" key={tier.priority}>
          <p>
            <strong>{TIER_TITLE[tier.priority]}</strong> — {tier.arrivingCount} of {tier.total}{' '}
            arriving.
          </p>
          {tier.missing.length === 0 ? (
            <p className="note">All arriving.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Not arriving</th>
                  <th>What it is for</th>
                </tr>
              </thead>
              <tbody>
                {tier.missing.map((item) => (
                  <tr key={item.name}>
                    <td>
                      <code>{item.name}</code>
                    </td>
                    <td className="note">{item.job}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ))}
    </>
  );
}

/** Brief Appendix B's three tiers, in the founder's words rather than ours. */
const TIER_TITLE: Record<string, string> = {
  must: 'Needed for the funnel, timing and the leaks',
  should: 'Needed for stalls, depth and the upgrade moment',
  could: 'Needed for the "why" behind a leak',
};

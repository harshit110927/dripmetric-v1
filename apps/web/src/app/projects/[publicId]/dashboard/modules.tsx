import Link from 'next/link';
import type { Dashboard } from '@/lib/dashboard';
import type { SerializedPerson } from '@dripmetric/db';
import { revealAction } from '../actions';

/**
 * The eight dashboard modules (brief §9).
 *
 * Two rules run through all of them. Every number can show how it is computed, so a
 * figure is never alone on the page — it has the rule or the formula beside it. And
 * nothing here decides what to mask: the rows arrive already serialized by the
 * data-access layer, and a module can only render what it was given.
 */

export function Money({ formula, amount }: { formula: string; amount: string }) {
  return (
    <p>
      <strong>{amount}</strong> <span className="note">{formula}</span>
    </p>
  );
}

/** A person, masked or not, with the reveal button when one can be spent. */
export function Person({
  person,
  publicId,
  canReveal,
}: {
  person: SerializedPerson;
  publicId: string;
  canReveal: boolean;
}) {
  if (!person.masked) {
    return (
      <>
        <strong>{person.name ?? person.email ?? person.userId}</strong>
        {person.email !== null && <span className="note"> {person.email}</span>}
        <br />
        {/*
         * Their id in the founder's own system, which is the join key back to it.
         * A name and an email are who they are; the id is how the founder finds
         * them in their own database, and it is the thing they will paste.
         */}
        <code className="note">{person.userId}</code>
        {person.company !== null && <span className="note"> · {person.company}</span>}
      </>
    );
  }

  return (
    <>
      <code>{person.tag}</code>{' '}
      <span className="note">
        {[person.emailHint, person.country, person.traitsHint].filter(Boolean).join(' · ')}
      </span>
      {canReveal && (
        <form action={revealAction} style={{ display: 'inline' }}>
          <input type="hidden" name="publicId" value={publicId} />
          {/* The tag is the handle: the row carries no id, by design. */}
          <input type="hidden" name="tag" value={person.tag} />
          <button type="submit" className="secondary" style={{ marginTop: 0 }}>
            Reveal
          </button>
        </form>
      )}
    </>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="note">{children}</p>;
}

/** Module 1: this week's leaks, with the money and its formula (brief §9). */
export function LeakSummary({ data }: { data: Dashboard }) {
  const { leaks } = data;

  return (
    <section>
      <h2>Where you are losing people</h2>
      {leaks.byType.length === 0 ? (
        <div className="card">
          <Empty>
            Nothing is leaking yet. Either things are going very well, or we are still waiting for
            enough events to judge.
          </Empty>
        </div>
      ) : (
        <div className="card">
          <table>
            <thead>
              <tr>
                <th>What</th>
                <th>Now</th>
                <th>This week</th>
                <th>At your price</th>
              </tr>
            </thead>
            <tbody>
              {leaks.byType.map((entry) => (
                <tr key={entry.type}>
                  <td>
                    {entry.type.replace(/-/g, ' ')}
                    <br />
                    <span className="note">{entry.rule}</span>
                  </td>
                  <td>{entry.open}</td>
                  <td>{entry.firedThisWeek}</td>
                  <td>
                    {entry.potentialRevenue === null ? (
                      <span className="note">not about people</span>
                    ) : (
                      <>
                        {(entry.potentialRevenue.amountMinor / 100).toFixed(2)}{' '}
                        {entry.potentialRevenue.currency.toUpperCase()}
                        <br />
                        <span className="note">{entry.potentialRevenue.formula}</span>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="note">
            Potential revenue is leaked people × your list price. It is what the leak could be
            worth, not money you have lost.
          </p>
        </div>
      )}

      {leaks.off.length > 0 && (
        <div className="card">
          <p className="note">These are switched off until the events arrive:</p>
          <ul>
            {leaks.off.map((off) => (
              <li key={off.type} className="note">
                <strong>{off.type.replace(/-/g, ' ')}</strong> — {off.because}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/** Module 2: the funnel (brief §9). */
export function FunnelModule({ data, publicId }: { data: Dashboard; publicId: string }) {
  const { funnel, trend } = data;

  return (
    <section>
      <h2>Your funnel</h2>
      {funnel.steps.length === 0 ? (
        <div className="card">
          <Empty>
            You have no steps yet. <Link href={`/projects/${publicId}/setup`}>Set them up</Link> and
            this fills in.
          </Empty>
        </div>
      ) : (
        <div className="card">
          <table>
            <thead>
              <tr>
                <th>Step</th>
                <th>Reached</th>
                <th>Finished</th>
                <th>Dropped</th>
                <th>Typical time</th>
                <th>Stuck now</th>
              </tr>
            </thead>
            <tbody>
              {funnel.steps.map((step) => (
                <tr key={step.stepId}>
                  <td>
                    {step.label}
                    {step.highlight.highlighted && (
                      <>
                        <br />
                        <span className="note">{step.highlight.says}</span>
                      </>
                    )}
                  </td>
                  <td>{step.entered}</td>
                  <td>{step.completed}</td>
                  <td>
                    {step.droppedOff}
                    {step.dropOffRate !== null && (
                      <span className="note"> ({Math.round(step.dropOffRate * 100)}%)</span>
                    )}
                  </td>
                  <td>
                    {step.elapsed.median === null ? (
                      <span className="note">{step.percentilesNote}</span>
                    ) : (
                      <>
                        {minutes(step.elapsed.median)}
                        <br />
                        <span className="note">
                          middle half {minutes(step.elapsed.p25!)}–{minutes(step.elapsed.p75!)},
                          slowest tenth over {minutes(step.elapsed.p90!)}
                        </span>
                      </>
                    )}
                  </td>
                  <td>{step.stuckNow}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {funnel.steps.some((step) => step.segmentWarnings.length > 0) && (
        <div className="card">
          <p className="note">Where one group does much worse than another:</p>
          <ul>
            {funnel.steps.flatMap((step) =>
              step.segmentWarnings.map((warning) => (
                <li key={`${step.stepId}-${warning.dimension}-${warning.value}`} className="note">
                  <strong>{step.label}</strong> — {warning.says}
                </li>
              )),
            )}
          </ul>
        </div>
      )}

      {trend.length > 0 && (
        <div className="card">
          <p className="note">Completions per week, by step, over the last 8 weeks.</p>
          <table>
            <thead>
              <tr>
                <th>Week</th>
                {funnel.steps.map((step) => (
                  <th key={step.stepId}>{step.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[...new Set(trend.map((row) => row.weekStart))].sort().map((week) => (
                <tr key={week}>
                  <td>{week}</td>
                  {funnel.steps.map((step) => {
                    const row = trend.find((t) => t.weekStart === week && t.stepId === step.stepId);
                    return (
                      <td key={step.stepId}>
                        {row === undefined ? (
                          <span className="note">—</span>
                        ) : (
                          `${row.completed}/${row.entered}`
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** Module 3: intent (brief §9). */
export function IntentModule({ data, publicId }: { data: Dashboard; publicId: string }) {
  const { intent, highIntent, reveals } = data;
  const canReveal = !reveals.everyone && reveals.remaining > 0;

  return (
    <section>
      <h2>Who looks ready to buy</h2>
      <div className="card">
        <p>
          <strong>{intent.bands.high}</strong> high · <strong>{intent.bands.warm}</strong> warm ·{' '}
          <strong>{intent.bands.low}</strong> low
          <br />
          <span className="note">
            Out of {intent.users} people, as they stand today. A score is 0 to 100 from what someone
            has done, and it halves for every week they are away — so someone who was at 80 a month
            ago is near zero now. The list below is everyone who ever reached 60, which is why their
            scores there can read 0 beside a high peak.
          </span>
        </p>

        {intent.didntPay.note !== null ? (
          <p className="warn">{intent.didntPay.note}</p>
        ) : (
          <p>
            <strong>{intent.didntPay.pastWindow}</strong> looked ready and did not pay, more than{' '}
            {intent.didntPay.windowDays} days ago. <strong>{intent.didntPay.insideWindow}</strong>{' '}
            still have time.
            {intent.didntPay.potentialRevenue !== null && (
              <>
                <br />
                <span className="note">{intent.didntPay.potentialRevenue.formula}</span>
              </>
            )}
          </p>
        )}
      </div>

      <div className="card">
        {highIntent.length === 0 ? (
          <Empty>Nobody has reached 60 yet.</Empty>
        ) : (
          <>
            <table>
              <thead>
                <tr>
                  <th>Who</th>
                  <th>Band</th>
                  <th>Score</th>
                  <th>Why</th>
                  <th>Last seen</th>
                </tr>
              </thead>
              <tbody>
                {highIntent.map((row, index) => (
                  <tr key={index}>
                    <td>
                      <Person person={row.person} publicId={publicId} canReveal={canReveal} />
                    </td>
                    {/* Brief §9: "a masked list with tag, band, leak and a coarse time". */}
                    <td>{row.band}</td>
                    <td>
                      {row.score}
                      <span className="note"> now, {row.peakScore} at their peak</span>
                    </td>
                    <td className="note">{row.leak ?? `${row.signalCount} signals`}</td>
                    <td className="note">{row.lastSeen}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="note">{reveals.note}</p>
          </>
        )}
      </div>
    </section>
  );
}

/** Module 4: checkout (brief §9). */
export function CheckoutModule({ data, publicId }: { data: Dashboard; publicId: string }) {
  const { checkout, drops, reveals } = data;
  const canReveal = !reveals.everyone && reveals.remaining > 0;

  return (
    <section>
      <h2>Checkout</h2>
      <div className="card">
        {checkout.started === 0 ? (
          <Empty>Nobody has started a checkout yet.</Empty>
        ) : (
          <p>
            <strong>{checkout.started}</strong> started, <strong>{checkout.completed}</strong>{' '}
            finished, <strong>{checkout.dropped}</strong> did not.
            {checkout.completionRate !== null && (
              <>
                <br />
                <span className="note">
                  {Math.round(checkout.completionRate * 100)}% of people who start a checkout finish
                  it. Trial-only checkouts are not counted.
                </span>
              </>
            )}
          </p>
        )}
        {checkout.note !== null && <p className="warn">{checkout.note}</p>}
      </div>

      {drops.length > 0 && (
        <div className="card">
          <p className="note">Last-moment drops still worth chasing:</p>
          <table>
            <tbody>
              {drops.map((row, index) => (
                <tr key={index}>
                  <td>
                    <Person person={row.person} publicId={publicId} canReveal={canReveal} />
                  </td>
                  <td className="note">{row.says}</td>
                  <td className="note">{row.when}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** Module 5: retention (brief §9). */
export function RetentionModule({ data }: { data: Dashboard }) {
  const { retention, cohorts, plan } = data;
  const showTable = plan.features.cohort_table;

  return (
    <section>
      <h2>Do they come back</h2>
      <div className="card">
        {retention.week1 === null && retention.week4 === null ? (
          <Empty>
            No cohort has finished its first week yet. These numbers appear once one has.
          </Empty>
        ) : (
          <p>
            {retention.week1 !== null && (
              <>
                <strong>{Math.round(retention.week1.rate * 100)}%</strong> came back in week 1{' '}
                <span className="note">
                  ({retention.week1.users} people who signed up in the week of{' '}
                  {retention.week1.cohortWeek})
                </span>
                <br />
              </>
            )}
            {retention.week4 !== null ? (
              <>
                <strong>{Math.round(retention.week4.rate * 100)}%</strong> came back in week 4{' '}
                <span className="note">
                  ({retention.week4.users} people from the week of {retention.week4.cohortWeek})
                </span>
              </>
            ) : (
              <span className="note">Week 4 appears once a cohort is four weeks old.</span>
            )}
          </p>
        )}
      </div>

      {showTable ? (
        <div className="card">
          <table>
            <thead>
              <tr>
                <th>Signed up in the week of</th>
                <th>People</th>
                <th>Week 1</th>
                <th>Week 4</th>
              </tr>
            </thead>
            <tbody>
              {cohorts.map((cohort) => (
                <tr key={cohort.cohortWeek}>
                  <td>{cohort.cohortWeek}</td>
                  <td>{cohort.users}</td>
                  <td>{percentOrWaiting(cohort.week1Rate)}</td>
                  <td>{percentOrWaiting(cohort.week4Rate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="card">
          <Empty>
            The full cohort table — every signup week, not just the two headline numbers — is part
            of the paid plan.
          </Empty>
        </div>
      )}
    </section>
  );
}

function percentOrWaiting(rate: number | null): React.ReactNode {
  if (rate === null) return <span className="note">not yet</span>;
  return `${Math.round(rate * 100)}%`;
}

/** Module 6: payers going quiet (brief §9). */
export function QuietPayersModule({ data, publicId }: { data: Dashboard; publicId: string }) {
  const { quietPayers, reveals } = data;
  const canReveal = !reveals.everyone && reveals.remaining > 0;

  return (
    <section>
      <h2>Paying customers going quiet</h2>
      <div className="card">
        {quietPayers.length === 0 ? (
          <Empty>
            None of your paying customers has dropped off against their own usual pattern.
          </Empty>
        ) : (
          <>
            <p>
              <strong>{quietPayers.length}</strong> of your paying customers are using it much less
              than they used to.
            </p>
            <table>
              <tbody>
                {quietPayers.map((row, index) => (
                  <tr key={index}>
                    <td>
                      <Person person={row.person} publicId={publicId} canReveal={canReveal} />
                    </td>
                    <td className="note">{row.says}</td>
                    <td className="note">{row.when}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
    </section>
  );
}

/** Module 7: tracking health (brief §9). The full version lands at M11. */
export function TrackingHealthModule({ data, publicId }: { data: Dashboard; publicId: string }) {
  const { coverage: cov, sources } = data;

  return (
    <section>
      <h2>Is the tracking healthy</h2>
      <div className="card">
        <p>
          <strong>{cov.score}%</strong> of the events we can use.
          {cov.unmappedCount > 0 && (
            <>
              {' '}
              <Link href={`/projects/${publicId}/inbox`}>
                {cov.unmappedCount} name{cov.unmappedCount === 1 ? '' : 's'} waiting in the Inbox
              </Link>
              .
            </>
          )}
        </p>
        {cov.switchedOff.length > 0 && (
          <>
            <p className="note">Off until the events arrive:</p>
            <ul>
              {cov.switchedOff.map((off) => (
                <li key={off.metric} className="note">
                  <strong>{off.metric}</strong> — {off.because}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      <div className="card">
        <p className="note">Where your events come from, over the last 7 days:</p>
        {sources.length === 0 ? (
          <Empty>No events in the last 7 days.</Empty>
        ) : (
          <table>
            <tbody>
              {sources.map((row) => (
                <tr key={row.source}>
                  <td>{row.source}</td>
                  <td>{row.events}</td>
                  <td className="note">{Math.round(row.share * 100)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="note">
          A product whose signups arrive only from a browser is losing the people who block scripts.
          Sending the important events from your server fixes that.
        </p>
      </div>
    </section>
  );
}

/** Module 8: changes (brief §9). */
export function ChangesModule({ data, publicId }: { data: Dashboard; publicId: string }) {
  const { changes } = data;

  return (
    <section>
      <h2>Did your changes work</h2>
      <div className="card">
        {changes.length === 0 ? (
          <Empty>
            You have not marked any changes yet.{' '}
            <Link href={`/projects/${publicId}/settings`}>Mark one</Link> when you ship something,
            and we freeze the thresholds so the before and after are measured against the same bar.
          </Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>What you changed</th>
                <th>When</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {changes.map((change) => (
                <tr key={change.id}>
                  <td>{change.note}</td>
                  <td className="note">{change.happenedAt.toISOString().slice(0, 10)}</td>
                  <td className="note">
                    {change.result === null
                      ? `Measuring. Thresholds for ${change.frozenSteps} steps are frozen at what they were.`
                      : JSON.stringify(change.result)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

function minutes(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)}s`;
  if (seconds < 90 * 60) return `${Math.round(seconds / 60)}m`;
  if (seconds < 48 * 3_600) return `${Math.round(seconds / 3_600)}h`;
  return `${Math.round(seconds / 86_400)}d`;
}

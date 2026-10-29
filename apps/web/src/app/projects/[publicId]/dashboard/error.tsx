'use client';

/**
 * The error state (brief §11, M9).
 *
 * It says what to do and offers to try again. It deliberately does not show the
 * error's text: a database message on a founder's screen helps nobody and can carry
 * a fragment of someone's data.
 */
export default function DashboardError({ reset }: { error: Error; reset: () => void }) {
  return (
    <>
      <h1>We could not load your numbers</h1>
      <p className="lede">
        Your events are safe — this is a problem reading them, not storing them.
      </p>
      <div className="card">
        <button type="button" onClick={reset}>
          Try again
        </button>
        <p className="note">
          If it keeps happening, the events are still arriving and nothing is lost. The page will
          catch up once we have fixed it.
        </p>
      </div>
    </>
  );
}

/**
 * The loading state (brief §11, M9).
 *
 * Bars rather than a spinner, in the shape of the page that is coming, so the layout
 * does not jump when the numbers arrive.
 */
export default function Loading() {
  return (
    <>
      <h1>Loading your numbers</h1>
      <p className="lede">This takes a moment the first time each minute.</p>
      {['Where you are losing people', 'Your funnel', 'Who looks ready to buy'].map((title) => (
        <section key={title}>
          <h2>{title}</h2>
          <div className="card">
            <p className="skeleton" />
            <p className="skeleton short" />
          </div>
        </section>
      ))}
    </>
  );
}

/**
 * Terms placeholder (brief §10). Honest about being a placeholder, for the same
 * reason as the privacy page: unreviewed legal text that looks real is worse than a
 * stated gap.
 */
export default function TermsPage() {
  return (
    <main style={{ maxWidth: 680, margin: '0 auto', padding: '40px 16px', lineHeight: 1.6 }}>
      <h1 style={{ fontSize: 24 }}>Terms</h1>

      <p style={{ background: '#fff8e1', padding: '10px 12px', borderRadius: 8, fontSize: 14 }}>
        <strong>This is a placeholder.</strong> It has not been reviewed by a lawyer and is not a
        contract.
      </p>

      <h2 style={{ fontSize: 17 }}>What this is</h2>
      <p>
        Dripmetric shows you where and how much revenue leaks between someone&apos;s first visit and
        their first payment. The free level shows where and how much; the paid level adds who and
        why.
      </p>

      <h2 style={{ fontSize: 17 }}>What the numbers are</h2>
      <p>
        Potential revenue figures are your own list price multiplied by a count of people, and every
        screen shows the arithmetic. They are not money we have observed changing hands, and you
        should not add them to your Stripe revenue.
      </p>

      <h2 style={{ fontSize: 17 }}>Retention</h2>
      <p>
        Raw events are kept for 90 days on the free level and 13 months on paid. Summaries are kept
        indefinitely. Upgrading does not bring back raw events that have already been deleted.
      </p>
    </main>
  );
}

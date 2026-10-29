/**
 * Privacy placeholder (brief §10: "the legal placeholder pages").
 *
 * A PLACEHOLDER, and it says so. The alternative — plausible-looking legal text
 * nobody reviewed — is worse than an honest gap: a founder could believe it covers
 * them, and it would be the one page on the site making a promise we have not
 * checked.
 *
 * What it does state is what the code actually does, because that part is true today
 * and is the part a founder evaluating us needs.
 */
export default function PrivacyPage() {
  return (
    <main style={{ maxWidth: 680, margin: '0 auto', padding: '40px 16px', lineHeight: 1.6 }}>
      <h1 style={{ fontSize: 24 }}>Privacy</h1>

      <p style={{ background: '#fff8e1', padding: '10px 12px', borderRadius: 8, fontSize: 14 }}>
        <strong>This is a placeholder.</strong> It has not been reviewed by a lawyer and is not a
        privacy policy. It describes what the product does so you can judge it; it makes no legal
        commitment.
      </p>

      <h2 style={{ fontSize: 17 }}>What we store for you</h2>
      <p>
        Product analytics events you send us: the event name, when it happened, the person&apos;s id
        in your system, the page, and whatever properties you choose to send. If you send an email
        address or a name, we encrypt it before it is stored.
      </p>

      <h2 style={{ fontSize: 17 }}>You are the controller</h2>
      <p>
        It is your data about your users. We process it to show you where your revenue leaks. We do
        not sell it, we do not use it to train anything, and we do not share it with other
        customers.
      </p>

      <h2 style={{ fontSize: 17 }}>Deletion</h2>
      <p>
        <code>DELETE /v1/users/:userId</code> removes every row we hold for one person, and the
        deletion is recorded in your audit log. Raw events are deleted automatically after your
        plan&apos;s retention window; the aggregate summaries we keep contain no one&apos;s
        identity.
      </p>

      <h2 style={{ fontSize: 17 }}>AI</h2>
      <p>
        We use a language model for one thing: suggesting what your own event names mean. Email
        addresses, names, ids, tokens and URLs with query strings are stripped before a prompt is
        built, and the list of what was withheld is written to your audit log.
      </p>
    </main>
  );
}

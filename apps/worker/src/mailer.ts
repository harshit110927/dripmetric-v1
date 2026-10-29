import type { OutgoingEmail } from '@dripmetric/ingest';
import { log } from './log.js';

/**
 * System email from the worker: the weekly report and the daily digest
 * (settled decision D5, Resend).
 *
 * The web app has its own copy of this for magic links, deliberately. The two
 * processes deploy separately — the app to Vercel, the worker to a long-running host
 * — and sharing one mailer would mean a package that both import, which would pull
 * the worker's env into the web bundle for the sake of one `fetch`.
 *
 * With no API key, mail goes to the log instead. That keeps `pnpm dev` working with
 * no account and keeps rule 3 honest: nothing here calls a paid API in a test.
 */
export async function sendSystemEmail(email: OutgoingEmail): Promise<void> {
  const key = process.env['RESEND_API_KEY'];
  const from = process.env['EMAIL_FROM'] ?? 'Dripmetric <hello@dripmetric.com>';

  if (!key) {
    log.info('email (no RESEND_API_KEY, not sent)', {
      to: email.to,
      subject: email.subject,
      // The body is deliberately not logged: a report names leaks, and on a paid
      // project those carry real names and addresses.
      bytes: email.text.length,
    });
    return;
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from,
      to: [email.to],
      subject: email.subject,
      text: email.text,
      ...(email.html ? { html: email.html } : {}),
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Resend refused the email (${response.status}): ${detail.slice(0, 300)}`);
  }
}

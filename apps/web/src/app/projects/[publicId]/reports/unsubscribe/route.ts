import { NextResponse } from 'next/server';
import { unsubscribeByToken, withProjectByPublicId } from '@dripmetric/db';

/**
 * One-click unsubscribe (brief §9: "with a one-click unsubscribe").
 *
 * No session, deliberately. This link is clicked from an inbox, often on a phone,
 * often by someone not logged in — asking them to sign in first is not one click. The
 * token IS the authorisation, which is why only its hash is stored and why the only
 * thing it can do is switch the emails off.
 *
 * It answers with a page rather than a redirect, because there is nowhere to send
 * someone who is not signed in.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ publicId: string }> },
): Promise<Response> {
  const { publicId } = await context.params;
  const token = new URL(request.url).searchParams.get('token');

  const done =
    token === null
      ? false
      : ((await withProjectByPublicId(publicId, (db) =>
          unsubscribeByToken(db, token, new Date()),
        )) ?? false);

  return new NextResponse(page(done), {
    status: done ? 200 : 400,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

function page(done: boolean): string {
  const message = done
    ? 'You are unsubscribed. We will not email you about this project again.'
    : 'That unsubscribe link is not valid any more. You can turn the emails off in your project settings.';

  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>Email settings</title></head>` +
    `<body style="margin:0;padding:48px 16px;background:#f6f7f9;` +
    `font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1f2430">` +
    `<div style="max-width:420px;margin:0 auto;background:#fff;border-radius:10px;padding:24px">` +
    `<p style="margin:0;font-size:16px;line-height:1.5">${message}</p>` +
    `</div></body></html>`
  );
}

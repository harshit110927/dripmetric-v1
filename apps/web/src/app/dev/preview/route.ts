import { NextResponse } from 'next/server';
import { withProjectByPublicId } from '@dripmetric/db';
import { weeklyReportFacts } from '@dripmetric/ingest';
import {
  alertContent,
  toDiscord,
  toSlack,
  weeklyReport,
  type AlertFacts,
} from '@dripmetric/engine';
import { isProduction, webEnv } from '@/lib/env';

/**
 * The dev preview (brief §9).
 *
 * "Provide a dev route that renders the report and an example alert from simulator
 * data, so I can look at them."
 *
 * It builds both from the SAME engine functions the jobs use, so what is on screen is
 * byte-identical to what would be emailed or posted. A preview rendered by its own
 * template would be a preview of the template.
 *
 *   /dev/preview?project=<publicId>            the weekly report, as HTML
 *   /dev/preview?project=<publicId>&as=text    the same, as the plain-text part
 *   /dev/preview?project=<publicId>&as=slack   the example alert's Slack payload
 *   /dev/preview?project=<publicId>&as=discord the same, as Discord's
 *
 * Refused in production: it renders a project's real report without a session.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  if (isProduction()) return new NextResponse('Not found', { status: 404 });

  const url = new URL(request.url);
  const publicId = url.searchParams.get('project');
  const as = url.searchParams.get('as') ?? 'html';
  if (!publicId) {
    return new NextResponse(
      'Pass ?project=<publicId>. Make one with `pnpm sim`, which prints it.',
      { status: 400 },
    );
  }

  const now = new Date();

  if (as === 'slack' || as === 'discord') {
    const content = alertContent(exampleAlert(publicId));
    return NextResponse.json(as === 'slack' ? toSlack(content) : toDiscord(content));
  }

  const built = await withProjectByPublicId(publicId, async (db, project) => {
    const facts = await weeklyReportFacts(db, now, {
      dashboardUrl: `${webEnv().APP_URL}/projects/${project.publicId}/dashboard`,
      unsubscribeUrl: `${webEnv().APP_URL}/projects/${project.publicId}/reports/unsubscribe?token=preview`,
    });
    return weeklyReport(facts);
  });

  if (built === null) return new NextResponse('No such project.', { status: 404 });

  if (as === 'text') {
    return new NextResponse(`Subject: ${built.subject}\n\n${built.text}`, {
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  /*
   * A banner above the real HTML.
   *
   * The report below it is exactly what Resend would send. The banner says what is
   * being looked at and that nothing was sent, because a preview that looks like a
   * sent email is a preview someone will mistake for one.
   */
  const banner =
    `<div style="max-width:560px;margin:0 auto 12px;padding:10px 14px;border-radius:8px;` +
    `background:#1f2430;color:#fff;font:13px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif">` +
    `<strong>Preview</strong> — this is the weekly report for <code>${escapeHtml(publicId)}</code>, ` +
    `built by the same engine the Monday job uses. Nothing was emailed. ` +
    `Subject: <em>${escapeHtml(built.subject)}</em>. ` +
    `Also: <a style="color:#9ec1ff" href="?project=${encodeURIComponent(publicId)}&as=text">text</a>, ` +
    `<a style="color:#9ec1ff" href="?project=${encodeURIComponent(publicId)}&as=slack">slack</a>, ` +
    `<a style="color:#9ec1ff" href="?project=${encodeURIComponent(publicId)}&as=discord">discord</a>.` +
    `</div>`;

  return new NextResponse(built.html.replace('<body', `${banner}<body`), {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

/**
 * One alert, with every field populated.
 *
 * Hand-written rather than read from the database, because the point of the preview
 * is to see a FULL alert: a real project often has no open leak with an intent score
 * and a plan and a repeat episode all at once, and an example missing half its fields
 * teaches nothing about the layout.
 */
function exampleAlert(publicId: string): AlertFacts {
  return {
    leakType: 'high-intent-quiet',
    says: 'They reached 72 on buying intent, then went 8 days without doing anything, and have not paid.',
    who: 'User A7F2C1',
    masked: true,
    intentScore: 72,
    plan: 'Free',
    atStakeMinor: 4_900,
    atStakeCurrency: 'usd',
    when: 'this week',
    episode: 2,
    dashboardUrl: `${webEnv().APP_URL}/projects/${publicId}/dashboard`,
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

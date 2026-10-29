import { NextResponse } from 'next/server';
import { unreadAlertCount } from '@dripmetric/db';
import { withOwnedProject } from '@/lib/project-access';

/**
 * The unread count, for the badge that "updates live" (brief §9).
 *
 * Polling rather than server-sent events. The number changes when a five-minute
 * sweep finds something, so a held-open connection per founder would be idle
 * 99.9% of the time — and on a serverless host it is a function instance held open
 * for nothing. A small poll is the honest shape for a value that moves this slowly.
 */
export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  context: { params: Promise<{ publicId: string }> },
): Promise<Response> {
  const { publicId } = await context.params;
  const unread = await withOwnedProject(publicId, (db) => unreadAlertCount(db));
  return NextResponse.json({ unread }, { headers: { 'cache-control': 'no-store' } });
}

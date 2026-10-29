import { NextResponse } from 'next/server';
import { firstEventState } from '@dripmetric/db';
import { withOwnedProject } from '@/lib/project-access';

/**
 * Has the first event arrived? (brief §9: "wait for the first event … and flip to
 * the live dashboard").
 *
 * Polling, as the brief allows. A held-open connection per founder would be idle
 * almost all of the time, and on a serverless host that is a function instance held
 * open waiting for one row.
 *
 * It returns the event NAMES as well as the count, because "we can see Page Viewed
 * and Signed Up" is what proves the snippet works — more convincingly than a number.
 */
export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  context: { params: Promise<{ publicId: string }> },
): Promise<Response> {
  const { publicId } = await context.params;
  const state = await withOwnedProject(publicId, (_db, project) =>
    firstEventState(project.id, new Date()),
  );
  return NextResponse.json(state, { headers: { 'cache-control': 'no-store' } });
}

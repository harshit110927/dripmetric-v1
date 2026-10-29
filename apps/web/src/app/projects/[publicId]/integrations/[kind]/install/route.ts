import { NextResponse } from 'next/server';
import { startInstall } from '@dripmetric/db';
import { withOwnedProject } from '@/lib/project-access';
import { authorizeRedirect, type IntegrationKind } from '@/lib/oauth';

/**
 * Starts the install: mint a state nonce, then redirect to the provider.
 *
 * A route handler and not a server action, because the end of this is a redirect to
 * someone else's domain. `withOwnedProject` checks who is asking before anything is
 * written, so a stranger cannot start an install against a project they cannot see.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ publicId: string; kind: string }> },
): Promise<Response> {
  const { publicId, kind } = await context.params;
  if (kind !== 'slack' && kind !== 'discord') {
    return new NextResponse('Unknown provider', { status: 404 });
  }

  const target = await withOwnedProject(publicId, async (db, _project, user) => {
    const state = await startInstall(db, kind as IntegrationKind, user.id, new Date());
    return authorizeRedirect(kind as IntegrationKind, publicId, state);
  });

  return NextResponse.redirect(target);
}

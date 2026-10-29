import { notFound, redirect } from 'next/navigation';
import { withProjectByPublicId, type Project, type ScopedDb } from '@dripmetric/db';
import { currentUser, userOwnsProject, type FounderUser } from './auth';

/**
 * "Load this project, for this founder, or stop."
 *
 * Every project page and every project action starts here. One function, so there is
 * no page that reads a project without checking who is asking — and the check is in
 * front of the scoped transaction, not inside it.
 */
export async function withOwnedProject<T>(
  publicId: string,
  fn: (db: ScopedDb, project: Project, user: FounderUser) => Promise<T>,
): Promise<T> {
  const user = await currentUser();
  if (!user) redirect('/login');

  // Membership is checked before the work runs, and `withProject` confines every
  // query inside it to this project (CLAUDE.md invariant 1).
  const result = await withProjectByPublicId(publicId, async (db, project) => {
    if (!(await userOwnsProject(user.id, project.id))) return null;
    return { value: await fn(db, project, user) };
  });

  if (!result) notFound();
  return result.value;
}

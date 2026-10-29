'use server';

import { headers } from 'next/headers';
import { startFreeAudit } from '@dripmetric/db';
import { liveProjectsAllowed } from '@/lib/env';

/**
 * The email-only instant project (brief §9's free audit).
 *
 * Like `createProjectAction`, this returns the keys in its own result and does not
 * redirect: a secret key is stored hashed and readable exactly once, so it exists
 * only for this response. Redirecting would throw it away.
 */
export interface AuditKeyView {
  kind: 'publishable' | 'secret';
  mode: 'live' | 'test';
  token: string;
}

export type AuditState =
  | { status: 'idle' }
  | { status: 'error'; message: string }
  | { status: 'started'; projectName: string; publicId: string; keys: AuditKeyView[] };

/**
 * The caller's IP, for the per-IP limit.
 *
 * `x-forwarded-for` is a list when there are several proxies, and the FIRST entry is
 * the client. Behind a proxy that strips it there is nothing to read, and the guard
 * treats that as "allow" rather than refusing everyone in that situation.
 */
async function callerIp(): Promise<string | null> {
  const header = (await headers()).get('x-forwarded-for');
  if (!header) return null;
  const first = header.split(',')[0]?.trim();
  return first && first.length > 0 ? first : null;
}

export async function startAuditAction(
  _previous: AuditState,
  formData: FormData,
): Promise<AuditState> {
  const email = String(formData.get('email') ?? '').trim();
  if (email.length === 0) return { status: 'error', message: 'Enter your email address.' };

  // Settled decision 1: no real founder data until backups exist.
  if (!liveProjectsAllowed()) {
    return {
      status: 'error',
      message:
        'Live projects are switched off until backups are confirmed. Set BACKUPS_CONFIRMED=true once backups are in place.',
    };
  }

  const result = await startFreeAudit({ email, ip: await callerIp() }, new Date());
  if (!result.ok) return { status: 'error', message: result.because };

  return {
    status: 'started',
    projectName: result.project.live.name,
    publicId: result.project.live.publicId,
    keys: result.project.keys.map((key) => ({
      kind: key.kind,
      mode: key.mode,
      token: key.token,
    })),
  };
}

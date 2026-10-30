import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from '../../middleware';
import { isProduction, liveProjectsAllowed } from '../env';
import type * as WebEnvModule from '../env';

/**
 * The hardening half of M13 (brief §10).
 *
 * Two things that are easy to get wrong and silent when they are: the gate on real
 * founder data, and the security headers.
 */

afterEach(() => {
  /*
   * `vi.unstubAllEnvs` rather than reassigning `process.env`.
   *
   * `NODE_ENV` is typed read-only, so assigning to it does not typecheck — which
   * only surfaced once `apps/web` was added to the root project references. Vitest's
   * own stubbing does the same job and restores cleanly.
   */
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('the gate on real founder data (settled decision 1)', () => {
  it('allows live projects in development, where there is no real data', () => {
    expect(isProduction()).toBe(false);
    expect(liveProjectsAllowed()).toBe(true);
  });

  it('refuses live projects in production until backups are confirmed', async () => {
    /*
     * The whole point of settled decision 1: "no real founder data until the shadow
     * copy or Supabase Pro backups exist. Supabase Free has no backups."
     *
     * The variable is a STATEMENT that backups exist. It does not create them, and
     * nothing here can check that they do — which is why the runbook says so in
     * those words.
     */
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('BACKUPS_CONFIRMED', '');
    const { liveProjectsAllowed: gated, isProduction: prod } = await freshEnv();
    expect(prod()).toBe(true);
    expect(gated()).toBe(false);

    vi.stubEnv('BACKUPS_CONFIRMED', 'true');
    const { liveProjectsAllowed: confirmed } = await freshEnv();
    expect(confirmed()).toBe(true);
  });

  it('accepts only exactly "true", not anything truthy', async () => {
    // "yes", "1" and "TRUE" are the kinds of thing someone sets in a hurry, and a
    // gate that accepts them is a gate that was never really closed.
    vi.stubEnv('NODE_ENV', 'production');
    for (const value of ['yes', '1', 'TRUE', 'True', 'on', '']) {
      vi.stubEnv('BACKUPS_CONFIRMED', value);
      const { liveProjectsAllowed: gated } = await freshEnv();
      expect(gated(), value).toBe(false);
    }
  });
});

/**
 * Re-imports `../env` so it reads `process.env` again.
 *
 * `webEnv()` memoizes on purpose — validating the environment once at startup is the
 * point — so the only way to test a different environment is to reload the module.
 * `vi.resetModules()` is how; a cache-busting query string is not, and silently
 * returned the same module.
 */
async function freshEnv(): Promise<typeof WebEnvModule> {
  vi.resetModules();
  return import('../env');
}

describe('security headers', () => {
  function headersFor(path: string): Headers {
    const response = middleware(new NextRequest(`http://localhost:3000${path}`));
    return response.headers;
  }

  it('sends a content security policy on the founder-facing pages', () => {
    const headers = headersFor('/projects/abc/dashboard');
    const csp = headers.get('content-security-policy') ?? '';

    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(headers.get('x-frame-options')).toBe('DENY');
    // Styles keep the inline allowance: the screens use inline style attributes,
    // which is what React renders.
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
  });

  it('carries a per-request nonce, because Next bootstraps with inline scripts', () => {
    /*
     * This is the regression test for a production-breaking bug.
     *
     * A plain `script-src 'self'` blocks Next's inline bootstrap
     * (`self.__next_f.push(...)`), so hydration never runs and streamed server
     * components never reach the DOM: the shell renders and five of the eight
     * dashboard modules stay invisible. `pnpm screens` caught it; this catches it
     * faster.
     *
     * `'unsafe-inline'` would "fix" it by removing the policy's only teeth, so the
     * assertion is specifically that a nonce is present and `unsafe-inline` is not.
     */
    const csp = headersFor('/projects/abc/dashboard').get('content-security-policy') ?? '';
    const scriptSrc = csp.split('; ').find((part) => part.startsWith('script-src')) ?? '';

    expect(scriptSrc).toMatch(/'nonce-[A-Za-z0-9+/=-]{8,}'/);
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    // `strict-dynamic` lets the nonced bootstrap load its own chunks without every
    // chunk URL being listed.
    expect(scriptSrc).toContain("'strict-dynamic'");
  });

  it('gives every request a different nonce', () => {
    // A reused nonce is barely better than `unsafe-inline`: anything that can read
    // one page can then inject a script that passes on the next.
    const first = headersFor('/login').get('content-security-policy') ?? '';
    const second = headersFor('/login').get('content-security-policy') ?? '';
    expect(first).not.toBe(second);
  });

  it('does not put a page CSP on the ingest API', () => {
    /*
     * `/v1/*` is a machine API called cross-origin by design. A CSP written for an
     * HTML document means nothing there, and `x-frame-options` on a JSON response is
     * noise that implies a protection it is not providing.
     */
    const headers = headersFor('/v1/batch');
    expect(headers.get('content-security-policy')).toBeNull();
    expect(headers.get('x-frame-options')).toBeNull();
    // What DOES matter on an API: a JSON error body a browser decides to read as
    // HTML is how content-type confusion becomes XSS.
    expect(headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('sets the headers that apply to everything', () => {
    for (const path of ['/projects/abc/dashboard', '/v1/batch']) {
      const headers = headersFor(path);
      expect(headers.get('x-content-type-options'), path).toBe('nosniff');
      expect(headers.get('referrer-policy'), path).toBe('strict-origin-when-cross-origin');
      expect(headers.get('permissions-policy'), path).toContain('camera=()');
    }
  });

  it('does not send HSTS in development', () => {
    /*
     * It would teach the browser to refuse `http://localhost:3000` for two years,
     * and `includeSubDomains` would do it to every other local project too. That is
     * a genuinely painful thing to do to a developer.
     */
    expect(headersFor('/login').get('strict-transport-security')).toBeNull();
  });
});

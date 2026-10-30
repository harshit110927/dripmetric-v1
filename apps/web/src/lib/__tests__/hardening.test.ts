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

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
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
    process.env['NODE_ENV'] = 'production';
    delete process.env['BACKUPS_CONFIRMED'];
    const { liveProjectsAllowed: gated, isProduction: prod } = await freshEnv();
    expect(prod()).toBe(true);
    expect(gated()).toBe(false);

    process.env['BACKUPS_CONFIRMED'] = 'true';
    const { liveProjectsAllowed: confirmed } = await freshEnv();
    expect(confirmed()).toBe(true);
  });

  it('accepts only exactly "true", not anything truthy', async () => {
    // "yes", "1" and "TRUE" are the kinds of thing someone sets in a hurry, and a
    // gate that accepts them is a gate that was never really closed.
    process.env['NODE_ENV'] = 'production';
    for (const value of ['yes', '1', 'TRUE', 'True', 'on', '']) {
      process.env['BACKUPS_CONFIRMED'] = value;
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
    // Scripts get no inline allowance: Next's bundles come from this origin.
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
    // Styles do, because the screens use inline style attributes, which is what
    // React renders.
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(headers.get('x-frame-options')).toBe('DENY');
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

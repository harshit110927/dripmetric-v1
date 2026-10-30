import { NextResponse, type NextRequest } from 'next/server';

/**
 * Security headers (brief §10, M13).
 *
 * Set in middleware rather than in `next.config` so the ingest routes can be given
 * different treatment from the founder's dashboard: `/v1/*` is a machine API called
 * cross-origin by design, and a CSP written for an HTML page would be meaningless
 * there while a frame-options header would be actively wrong.
 */
export const config = {
  // Everything except Next's own static output, which it serves with its own headers.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};

/**
 * The script sources the dashboard needs.
 *
 * `'unsafe-inline'` for styles only, and it is not an oversight: the screens are
 * styled with inline `style` attributes, which is what React renders and what keeps
 * the pages dependency-free. Scripts have no such allowance — Next's own bundles are
 * served from this origin and nothing else is loaded.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  // The dashboard talks to this origin only. An alert channel is posted to by the
  // worker, never by the browser.
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

export function middleware(request: NextRequest): NextResponse {
  const response = NextResponse.next();
  const isApi = request.nextUrl.pathname.startsWith('/v1/');

  /*
   * Applied to both, because they are true of both.
   *
   * `nosniff` matters more on the API than on the pages: a JSON error body that a
   * browser decides to treat as HTML is how a content-type confusion bug becomes an
   * XSS one.
   */
  response.headers.set('x-content-type-options', 'nosniff');
  response.headers.set('referrer-policy', 'strict-origin-when-cross-origin');
  response.headers.set(
    'permissions-policy',
    'camera=(), microphone=(), geolocation=(), payment=()',
  );

  if (isApi) {
    // An API response is never a document, so there is nothing to frame or sniff into
    // a page. CORS is handled per-route, because only ingest allows an origin.
    return response;
  }

  response.headers.set('content-security-policy', CSP);
  response.headers.set('x-frame-options', 'DENY');
  /*
   * HSTS, but only in production.
   *
   * On localhost it would teach the browser to refuse `http://localhost:3000` for the
   * next two years, which is a genuinely painful thing to do to a developer — and
   * `includeSubDomains` would do it to every other local project too.
   */
  if (process.env.NODE_ENV === 'production') {
    response.headers.set(
      'strict-transport-security',
      'max-age=63072000; includeSubDomains; preload',
    );
  }

  return response;
}

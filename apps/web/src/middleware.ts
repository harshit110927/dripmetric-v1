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
 * The policy, built per request around a fresh nonce.
 *
 * A plain `script-src 'self'` here was a production-breaking bug, and the dashboard
 * screenshot check is what caught it. Next streams server components and bootstraps
 * them with INLINE scripts (`self.__next_f.push(...)`); with no `'unsafe-inline'` and
 * no nonce the browser blocks them, so hydration never runs and the streamed content
 * never reaches the DOM. The shell renders, five of the eight dashboard modules stay
 * invisible, and nothing is interactive — for every user, not just in a test.
 *
 * A nonce is the fix rather than `'unsafe-inline'`, which would defeat the point of
 * having a script policy at all. Next picks the nonce out of the CSP on the REQUEST
 * headers and stamps it onto its own script tags, which is why the header is set on
 * both the request and the response below.
 *
 * `'strict-dynamic'` lets those nonced scripts load the chunks they need without
 * every chunk URL being listed. Styles keep `'unsafe-inline'` deliberately: the
 * screens are styled with inline `style` attributes, which is what React renders.
 */
function cspFor(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
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
}

export function middleware(request: NextRequest): NextResponse {
  const isApi = request.nextUrl.pathname.startsWith('/v1/');

  /*
   * The nonce goes on the REQUEST headers, not only the response.
   *
   * That is how Next finds it: it reads the `content-security-policy` request header,
   * extracts the nonce and adds it to the script tags it renders. Setting it only on
   * the response would produce a policy that blocks the very scripts the response
   * contains.
   */
  const nonce = isApi ? '' : crypto.randomUUID();
  const csp = isApi ? '' : cspFor(nonce);

  const requestHeaders = new Headers(request.headers);
  if (!isApi) requestHeaders.set('content-security-policy', csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });

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

  response.headers.set('content-security-policy', csp);
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

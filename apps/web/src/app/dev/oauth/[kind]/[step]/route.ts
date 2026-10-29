import { NextResponse } from 'next/server';
import { isProduction, webEnv } from '@/lib/env';

/**
 * The Slack and Discord OAuth mock (brief §9, M10: "against mocks").
 *
 * Two endpoints behind one route: `/authorize` redirects straight back with a code,
 * and `/token` returns the provider's own documented token shape. The real flow runs
 * against it unchanged — same state nonce, same single-use check, same exchange — so
 * what the install code path does here is what it will do in production.
 *
 * Shapes verified against the live docs on 2026-10-29. Slack nests the webhook under
 * `incoming_webhook` with `ok: true`; Discord nests it under `webhook`.
 *
 * Refused in production. A mock that answers on a real deployment would hand anyone
 * a working "install" that posts nowhere.
 */
export const dynamic = 'force-dynamic';

async function handle(request: Request, kind: string, step: string): Promise<Response> {
  if (isProduction()) return new NextResponse('Not found', { status: 404 });
  if (kind !== 'slack' && kind !== 'discord') {
    return new NextResponse('Unknown provider', { status: 404 });
  }

  const url = new URL(request.url);

  if (step === 'authorize') {
    const redirectUri = url.searchParams.get('redirect_uri');
    const state = url.searchParams.get('state');
    if (!redirectUri || !state) return new NextResponse('Missing parameters', { status: 400 });

    // Straight back, as the provider would after the founder picks a channel.
    const back = new URL(redirectUri);
    back.searchParams.set('code', 'dev-code-0001');
    back.searchParams.set('state', state);
    return NextResponse.redirect(back.toString());
  }

  if (step === 'token') {
    const body = new URLSearchParams(await request.text());
    if (!body.get('code')) {
      return NextResponse.json({ ok: false, error: 'invalid_code' }, { status: 200 });
    }

    /*
     * A webhook URL on a host that does not resolve.
     *
     * Deliberate: a dev install must never produce a URL that could reach a real
     * workspace, and `.test` is reserved by RFC 6761 so it can never be registered.
     * The dispatcher's failure path is then what dev exercises, which is the half
     * most likely to be wrong.
     */
    const webhookUrl = `https://hooks.${kind}.test/services/DEV/${Date.now()}/mock`;

    return NextResponse.json(
      kind === 'slack'
        ? {
            ok: true,
            access_token: 'xoxp-dev-token',
            scope: 'incoming-webhook',
            team_name: 'Dev Workspace',
            team_id: 'T_DEV',
            incoming_webhook: {
              channel: '#leaks',
              channel_id: 'C_DEV',
              configuration_url: `${webEnv().APP_URL}/dev/oauth/slack`,
              url: webhookUrl,
            },
          }
        : {
            access_token: 'discord-dev-token',
            token_type: 'Bearer',
            scope: 'webhook.incoming',
            webhook: {
              id: 'W_DEV',
              channel_id: 'C_DEV',
              guild_id: 'G_DEV',
              name: 'Dripmetric',
              url: webhookUrl,
            },
          },
    );
  }

  return new NextResponse('Not found', { status: 404 });
}

export async function GET(
  request: Request,
  context: { params: Promise<{ kind: string; step: string }> },
): Promise<Response> {
  const { kind, step } = await context.params;
  return handle(request, kind, step);
}

export async function POST(
  request: Request,
  context: { params: Promise<{ kind: string; step: string }> },
): Promise<Response> {
  const { kind, step } = await context.params;
  return handle(request, kind, step);
}

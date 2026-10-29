import { webEnv } from './env';

/**
 * Slack and Discord OAuth, pointed at a mock in development (brief §9, §10).
 *
 * "Slack and Discord OAuth (against mocks)" is M10's own wording, and it is also the
 * only way this can be built without a real workspace: the install flow is a redirect
 * to someone else's domain and a `code` exchange against their token endpoint.
 *
 * Both endpoints come from env, so dev and tests point at `/dev/oauth/<kind>` in this
 * same app and production points at the real ones. Nothing in the flow is faked — the
 * state nonce, the single-use check and the code exchange all run exactly as they
 * will in production; only the host differs.
 *
 * Verified against the current docs on 2026-10-29:
 *  - Slack returns the webhook URL at `incoming_webhook.url`, with the channel at
 *    `incoming_webhook.channel`, and needs the `incoming-webhook` scope, which is
 *    what shows the channel picker.
 *    https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks
 *  - Discord's `webhook.incoming` scope returns a `webhook` object with `url`,
 *    `channel_id` and `guild_id` on the token response.
 *    https://docs.discord.com/developers/topics/oauth2
 */

export type IntegrationKind = 'slack' | 'discord';

export interface OAuthEndpoints {
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scope: string;
}

/** Slack's scope for an incoming webhook, and Discord's. Both from their docs. */
const SCOPES: Record<IntegrationKind, string> = {
  slack: 'incoming-webhook',
  discord: 'webhook.incoming',
};

export function endpointsFor(kind: IntegrationKind): OAuthEndpoints {
  const env = webEnv();
  const configured = kind === 'slack' ? env.SLACK_OAUTH_BASE : env.DISCORD_OAUTH_BASE;
  /*
   * A relative default is resolved against our own origin.
   *
   * `/dev/oauth/slack` is the mock inside this app, and both `new URL()` and a
   * server-side `fetch` need an absolute URL — a relative one throws rather than
   * guessing a host.
   */
  const base = configured.startsWith('/') ? `${env.APP_URL}${configured}` : configured;

  return {
    authorizeUrl: `${base}/authorize`,
    tokenUrl: `${base}/token`,
    clientId: (kind === 'slack' ? env.SLACK_CLIENT_ID : env.DISCORD_CLIENT_ID) ?? 'dev-client-id',
    clientSecret:
      (kind === 'slack' ? env.SLACK_CLIENT_SECRET : env.DISCORD_CLIENT_SECRET) ?? 'dev-secret',
    scope: SCOPES[kind],
  };
}

export function redirectUri(kind: IntegrationKind, publicId: string): string {
  return `${webEnv().APP_URL}/projects/${publicId}/integrations/${kind}/callback`;
}

/** The URL the founder is sent to. One click, as the brief asks. */
export function authorizeRedirect(kind: IntegrationKind, publicId: string, state: string): string {
  const endpoints = endpointsFor(kind);
  const url = new URL(endpoints.authorizeUrl);
  url.searchParams.set('client_id', endpoints.clientId);
  url.searchParams.set('scope', endpoints.scope);
  url.searchParams.set('state', state);
  url.searchParams.set('redirect_uri', redirectUri(kind, publicId));
  return url.toString();
}

export interface ExchangedWebhook {
  webhookUrl: string;
  channelLabel: string;
  workspaceLabel: string;
}

/**
 * Exchanges the `code` for a webhook URL.
 *
 * The two providers nest it differently, which is the only reason this function is
 * not three lines. Slack puts it under `incoming_webhook`; Discord puts it under
 * `webhook`. Both are read defensively, because a provider returning a 200 with a
 * shape we did not expect must fail loudly here rather than store an empty string as
 * a credential.
 */
export async function exchangeCode(
  kind: IntegrationKind,
  publicId: string,
  code: string,
): Promise<ExchangedWebhook> {
  const endpoints = endpointsFor(kind);

  const response = await fetch(endpoints.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: endpoints.clientId,
      client_secret: endpoints.clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri(kind, publicId),
    }),
  });

  if (!response.ok) {
    throw new Error(`${kind} refused the code exchange (${response.status}).`);
  }

  const body = (await response.json()) as Record<string, unknown>;

  // Slack signals failure with `ok: false` and HTTP 200.
  if (kind === 'slack' && body['ok'] === false) {
    throw new Error(`Slack refused the install: ${String(body['error'] ?? 'unknown')}.`);
  }

  const nested = (kind === 'slack' ? body['incoming_webhook'] : body['webhook']) as
    Record<string, unknown> | undefined;
  const webhookUrl = typeof nested?.['url'] === 'string' ? nested['url'] : '';

  if (!webhookUrl.startsWith('https://')) {
    throw new Error(`${kind} did not return a webhook URL.`);
  }

  return {
    webhookUrl,
    channelLabel:
      typeof nested?.['channel'] === 'string'
        ? nested['channel']
        : typeof nested?.['channel_id'] === 'string'
          ? `channel ${nested['channel_id']}`
          : 'your channel',
    workspaceLabel:
      typeof body['team_name'] === 'string'
        ? body['team_name']
        : typeof nested?.['guild_id'] === 'string'
          ? `server ${nested['guild_id']}`
          : '',
  };
}

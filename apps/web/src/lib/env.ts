import { z } from 'zod';

/**
 * The web app's own environment, on top of what @dripmetric/db validates.
 * Validated once at import, so a missing variable is a clear startup error.
 */
const WebEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_URL: z.string().url().default('http://localhost:3000'),
  AUTH_SECRET: z.string().min(32, 'AUTH_SECRET must be at least 32 characters.'),
  /** Empty in dev and in tests: mail goes to the console mailbox instead. */
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().default('Dripmetric <hello@dripmetric.com>'),
  /** M13 guard (settled decision 1): no live project without confirmed backups. */
  BACKUPS_CONFIRMED: z.string().optional(),
  /**
   * Mapping suggestions (brief §7: "a real call behind an env var, a mock in
   * tests"). Absent means the Inbox works by hand, which it must anyway.
   */
  ANTHROPIC_API_KEY: z.string().optional(),
  /** Brief §7: "keep the model id, price and prompt in config." */
  ANTHROPIC_MODEL: z.string().default('claude-haiku-5-5'),

  /*
   * Slack and Discord OAuth (brief §9, M10: "against mocks").
   *
   * The base URL is configurable so dev and tests point at `/dev/oauth/<kind>` in
   * this same app while production points at the real endpoints. The flow itself is
   * identical either way — same state nonce, same single-use check, same code
   * exchange — so what the mock exercises is the real code path.
   */
  SLACK_OAUTH_BASE: z.string().default('/dev/oauth/slack'),
  DISCORD_OAUTH_BASE: z.string().default('/dev/oauth/discord'),
  SLACK_CLIENT_ID: z.string().optional(),
  SLACK_CLIENT_SECRET: z.string().optional(),
  DISCORD_CLIENT_ID: z.string().optional(),
  DISCORD_CLIENT_SECRET: z.string().optional(),
});

let cached: z.infer<typeof WebEnvSchema> | undefined;

export function webEnv() {
  if (cached) return cached;
  const parsed = WebEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(
      'Environment is not usable:\n' +
        parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n') +
        '\n\nCopy .env.example to .env.',
    );
  }
  cached = parsed.data;
  return cached;
}

export function isProduction(): boolean {
  return webEnv().NODE_ENV === 'production';
}

/**
 * Settled decision 1: Supabase Free has no backups, so no real founder data until the
 * shadow copy or Supabase Pro backups exist. In production, creating a live project
 * needs the founder's explicit confirmation.
 */
export function liveProjectsAllowed(): boolean {
  return !isProduction() || webEnv().BACKUPS_CONFIRMED === 'true';
}

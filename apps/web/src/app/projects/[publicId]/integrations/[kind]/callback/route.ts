import { NextResponse } from 'next/server';
import { consumeInstallState, saveIntegration, updateSettings } from '@dripmetric/db';
import { withOwnedProject } from '@/lib/project-access';
import { exchangeCode, type IntegrationKind } from '@/lib/oauth';

/**
 * Finishes the install.
 *
 * The order matters. The state is spent FIRST, in an UPDATE whose own WHERE clause
 * requires it to be unused — so a replayed callback fails before a code is ever
 * exchanged. Only then is the code swapped for a webhook URL, and only then stored.
 *
 * Errors come back as a message on the settings page rather than a stack trace: the
 * founder is in a browser, mid-flow, and "Slack refused the install" is something
 * they can act on.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ publicId: string; kind: string }> },
): Promise<Response> {
  const { publicId, kind } = await context.params;
  if (kind !== 'slack' && kind !== 'discord') {
    return new NextResponse('Unknown provider', { status: 404 });
  }

  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const settingsUrl = new URL(`/projects/${publicId}/settings`, url.origin);

  // The founder pressed Cancel on the provider's screen. Not an error.
  const denied = url.searchParams.get('error');
  if (denied) {
    settingsUrl.searchParams.set('integration', `cancelled:${denied}`);
    return NextResponse.redirect(settingsUrl.toString());
  }

  if (!code || !state) {
    settingsUrl.searchParams.set('integration', 'error:the provider sent no code');
    return NextResponse.redirect(settingsUrl.toString());
  }

  const outcome = await withOwnedProject(publicId, async (db, _project, user) => {
    const spent = await consumeInstallState(db, kind as IntegrationKind, state, new Date());
    if (!spent) {
      // Expired, already used, or not ours. All three mean: start again.
      return 'error:that install link was already used or has expired';
    }

    try {
      const exchanged = await exchangeCode(kind as IntegrationKind, publicId, code);
      const saved = await saveIntegration(
        db,
        {
          kind: kind as IntegrationKind,
          webhookUrl: exchanged.webhookUrl,
          channelLabel: exchanged.channelLabel,
          workspaceLabel: exchanged.workspaceLabel,
        },
        user.id,
      );

      /*
       * Installing a channel also selects it.
       *
       * A founder who has just connected Slack means "send my alerts there". Leaving
       * `alertChannel` on `none` would make the install appear to work and change
       * nothing, which is the worst of both.
       */
      await updateSettings(db, user.id, { alertChannel: kind });
      return `connected:${saved.channelLabel}`;
    } catch (error) {
      return `error:${error instanceof Error ? error.message : 'the install failed'}`;
    }
  });

  settingsUrl.searchParams.set('integration', outcome);
  return NextResponse.redirect(settingsUrl.toString());
}

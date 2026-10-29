import {
  alertSubjects,
  channelPostsSince,
  currentProject,
  dueDeliveries,
  entitlements,
  limitOf,
  liveIntegration,
  markDelivered,
  markDeliveryFailed,
  noteIntegrationResult,
  recordAlert,
  serializeContext,
  skipDelivery,
  withProject,
  type DueDelivery,
  type ScopedDb,
} from '@dripmetric/db';
import {
  alertContent,
  decideAlerts,
  startOfLocalDay,
  toDiscord,
  toSlack,
  type AlertCandidate,
  type AlertChannel,
  type LeakType,
} from '@dripmetric/engine';

/**
 * Turning recorded leaks into alerts, and alerts into channel posts (brief §9).
 *
 * Two passes, deliberately separate. DECIDE writes the feed row and the delivery
 * row, and is pure policy over facts. DELIVER posts what is due and is the only part
 * that touches the network.
 *
 * Splitting them is what makes the retry safe: a post that fails has already been
 * recorded in the feed, so retrying is a retry of one HTTP request and never a
 * second alert. It is also what lets the quiet-hours hold work at all — a held
 * delivery is just a row with a later `due_at`, which the deliver pass picks up when
 * the morning comes.
 */

/** The HTTP call, injectable so tests never reach Slack or Discord (rule 3). */
export type PostWebhook = (
  url: string,
  body: unknown,
) => Promise<{ ok: boolean; status: number; detail: string }>;

export const postWebhook: PostWebhook = async (url, body) => {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const detail = await response.text().catch(() => '');
  return { ok: response.ok, status: response.status, detail: detail.slice(0, 300) };
};

export interface DispatchResult {
  /** How many leaks were looked at. */
  considered: number;
  /** Feed rows written. */
  recorded: number;
  sending: number;
  held: number;
  feedOnly: number;
  overCap: number;
  dropped: number;
}

/**
 * The decide pass.
 *
 * Everything it needs comes from the database as facts, and the decision itself is
 * the engine's. The guards in particular are read fresh here rather than trusted
 * from when the leak was recorded (brief §9: "Never alert about someone who already
 * paid, was deleted or opted out").
 */
export async function decideProjectAlerts(db: ScopedDb, now: Date): Promise<DispatchResult> {
  const project = await currentProject(db);
  const plan = await entitlements(db);
  const context = await serializeContext(db, now);
  const subjects = await alertSubjects(db, context);

  const empty: DispatchResult = {
    considered: 0,
    recorded: 0,
    sending: 0,
    held: 0,
    feedOnly: 0,
    overCap: 0,
    dropped: 0,
  };
  if (subjects.length === 0) return empty;

  const channel = project.settings.alertChannel as AlertChannel;
  // Which integration a post would go to. Null means the founder chose a chat app
  // and never finished installing it, which is a feed-only alert, not an error.
  const integration =
    channel === 'slack' || channel === 'discord' ? await liveIntegration(db, channel) : null;

  const candidates: AlertCandidate[] = subjects.map((subject) => ({
    leakInstanceId: subject.leakInstanceId,
    leakType: subject.leakType as LeakType,
    subjectKind: subject.subjectKind,
    subjectKey: subject.subjectKey,
    firedAt: subject.firedAt,
  }));

  const plan_ = decideAlerts({
    candidates,
    channel: integration === null && channel !== 'email-digest' ? 'none' : channel,
    timeZone: project.timezone,
    quietHours: project.settings.quietHours,
    // The cap counts the founder's local day, which the engine works out.
    sentToday: await channelPostsSince(db, startOfLocalDay(now, project.timezone)),
    cap: limitOf(plan, 'instant_alerts_per_day'),
    guards: new Map(subjects.map((subject) => [subject.subjectKey, subject.guards])),
    now,
  });

  const result: DispatchResult = {
    considered: subjects.length,
    recorded: 0,
    sending: plan_.sending,
    held: plan_.held,
    feedOnly: plan_.feedOnly,
    overCap: plan_.overCap,
    dropped: plan_.dropped,
  };

  const bySubject = new Map(subjects.map((subject) => [subject.leakInstanceId, subject]));

  for (const decision of plan_.decisions) {
    // Dropped: they paid, were deleted or opted out. Not even the feed — the feed is
    // a list of things to act on, and there is nothing to do about these.
    if (decision.route === 'drop') continue;

    const subject = bySubject.get(decision.candidate.leakInstanceId);
    if (!subject) continue;

    const content = alertContent({
      leakType: decision.candidate.leakType,
      says: subject.says,
      who: subject.who ?? 'Someone',
      masked: subject.masked,
      intentScore: subject.subjectKind === 'user' ? subject.intentScore : null,
      plan: subject.plan,
      atStakeMinor: project.settings.listPriceAmount,
      atStakeCurrency: project.settings.listPriceCurrency,
      when: subject.when,
      episode: subject.episode,
      dashboardUrl: null,
    });

    const written = await recordAlert(db, {
      leakInstanceId: decision.candidate.leakInstanceId,
      leakType: decision.candidate.leakType,
      subjectKind: decision.candidate.subjectKind,
      subjectKey: decision.candidate.subjectKey,
      firedAt: decision.candidate.firedAt,
      title: content.title,
      says: content.says,
      fields: content.fields,
      masked: decision.masked,
      route: decision.route,
      because: decision.because,
      delivery:
        decision.route === 'feed-only' || integration === null
          ? null
          : {
              channel: integration.kind,
              integrationId: integration.id,
              dueAt: decision.holdUntil ?? now,
            },
    });

    if (written !== null) result.recorded++;
  }

  return result;
}

export interface DeliveryResult {
  sent: number;
  failed: number;
  skipped: number;
  retrying: number;
}

/**
 * The deliver pass: post what is due.
 *
 * A 404 or 410 from a webhook means the channel or the app is gone, which is not
 * worth retrying four more times — it is worth telling the founder their integration
 * is broken. Everything else gets the backoff.
 */
export async function deliverDueAlerts(
  db: ScopedDb,
  now: Date,
  options: { post?: PostWebhook } = {},
): Promise<DeliveryResult> {
  const post = options.post ?? postWebhook;
  const result: DeliveryResult = { sent: 0, failed: 0, skipped: 0, retrying: 0 };

  const due = await dueDeliveries(db, now);
  if (due.length === 0) return result;

  // One lookup per kind, not per delivery: the webhook URL is a decryption each time.
  const integrations = new Map<string, Awaited<ReturnType<typeof liveIntegration>>>();
  const resolve = async (kind: 'slack' | 'discord') => {
    if (!integrations.has(kind)) integrations.set(kind, await liveIntegration(db, kind));
    return integrations.get(kind) ?? null;
  };

  for (const delivery of due) {
    if (delivery.channel === 'email') continue; // the digest job owns these

    const integration = await resolve(delivery.channel);
    if (integration === null) {
      await skipDelivery(
        db,
        delivery.deliveryId,
        'The chat app was disconnected before this could be sent. It is still in your feed.',
      );
      result.skipped++;
      continue;
    }

    const body = payloadFor(delivery);
    const response = await post(integration.webhookUrl, body);

    if (response.ok) {
      await markDelivered(db, delivery.deliveryId, now);
      await noteIntegrationResult(db, integration.id, { ok: true });
      result.sent++;
      continue;
    }

    const gone = response.status === 404 || response.status === 410;
    const error = `${response.status}: ${response.detail}`;

    if (gone) {
      await skipDelivery(db, delivery.deliveryId, `The channel is gone (${response.status}).`);
      await noteIntegrationResult(db, integration.id, { ok: false, error });
      result.skipped++;
      continue;
    }

    const { willRetry } = await markDeliveryFailed(db, delivery.deliveryId, error, now);
    await noteIntegrationResult(db, integration.id, { ok: false, error });
    if (willRetry) result.retrying++;
    else result.failed++;
  }

  return result;
}

/** Rebuilds the channel payload from the STORED alert, not from the leak. */
function payloadFor(delivery: DueDelivery): unknown {
  /*
   * The stored title, sentence and fields are replayed as they were written.
   *
   * A retry an hour later must send what the first attempt would have sent: the
   * thresholds may have moved, the person may now look different, and an alert whose
   * text changed between attempts would leave the founder's Slack history disagreeing
   * with their feed.
   */
  const content = {
    leakType: delivery.leakType as LeakType,
    title: delivery.title,
    says: delivery.says,
    fields: delivery.fields,
    rule: '',
    link: null,
    masked: delivery.masked,
    urgency: 'warn' as const,
  };

  return delivery.channel === 'slack' ? toSlack(content) : toDiscord(content);
}

/** The worker's entry point: decide, then deliver, in one project. */
export async function runAlertDispatch(
  projectId: number,
  now: Date,
  options: { post?: PostWebhook } = {},
): Promise<DispatchResult & DeliveryResult> {
  const decided = await withProject(projectId, (db) => decideProjectAlerts(db, now), {
    worker: true,
  });
  const delivered = await withProject(projectId, (db) => deliverDueAlerts(db, now, options), {
    worker: true,
  });
  return { ...decided, ...delivered };
}

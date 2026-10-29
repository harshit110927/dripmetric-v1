import { handleBatch } from '@dripmetric/ingest';
import type { CreatedProject } from '@dripmetric/db';
import { deliveredAt } from '../faults.js';
import type { SimMessage } from '../types.js';

/**
 * Loads a simulated run through the real ingest pipeline, as the four sim tests do.
 *
 * It was four near-identical copies of the same thirty lines. This is the one copy.
 *
 * The batching looks wasteful and is not, which is worth writing down because it
 * cost an afternoon to re-learn. A batch closes whenever the stream switches between
 * a browser-sent and a server-sent message, and the simulator interleaves them one at
 * a time — so a 300-user run of 6,218 messages goes out as ~1,782 batches averaging
 * 3.5 messages. Packing them into 35 batches of 200 is five times faster and WRONG:
 *
 *   `receivedAt` is the batch's arrival time, and it is derived from the messages in
 *   it. A simulated run spans weeks, so a batch of 200 consecutive messages spans
 *   days of simulated time. Its arrival time is the latest of them, which makes the
 *   other 199 arrive long after their own timestamps — and an event older than the
 *   request carrying it is the definition of a late event (`FLAG_LATE`).
 *
 * Packing therefore flags almost everything late and moves the filtered and duplicate
 * counts with it. Three tests in `ingest.test.ts` caught exactly that. Small
 * time-local batches are what a real client does: it holds events briefly and posts
 * them promptly, so `received_at` stays close to the event's own time.
 *
 * The cost of the fidelity is ~1,782 transactions, each a full pipeline pass. That is
 * inherent to replaying weeks of history faithfully, not an accident to optimise away.
 */

/** A browser user agent: curl-shaped agents are correctly filtered as bots. */
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36';

/** The batch size the SDK and `pnpm sim` both use (brief §5). */
export const SEND_BATCH_SIZE = 200;

export interface SendKeys {
  publishable: string;
  secret: string;
}

/** What the API said about every message, for the tests that check the counts. */
export interface SendTally {
  ok: number;
  duplicate: number;
  filtered: number;
  errors: Record<string, number>;
}

export function keysOf(project: CreatedProject): SendKeys {
  const publishable = project.keys.find((k) => k.kind === 'publishable' && k.mode === 'live');
  const secret = project.keys.find((k) => k.kind === 'secret' && k.mode === 'live');
  if (!publishable || !secret) throw new Error('createProject did not return both live keys.');
  return { publishable: publishable.token, secret: secret.token };
}

/**
 * `userAgent: null` omits the header entirely.
 *
 * The ingest test sent no user agent and the other three sent a browser one, and the
 * difference is load-bearing: that test asserts how many messages are FILTERED, and
 * bot detection reads the agent. Consolidating the four helpers had to keep each
 * call's own behaviour, not pick whichever looked tidier.
 */
export async function sendRun(
  messages: readonly SimMessage[],
  keys: SendKeys,
  options: { userAgent?: string | null } = {},
): Promise<SendTally> {
  const tally: SendTally = { ok: 0, duplicate: 0, filtered: 0, errors: {} };
  const userAgent = options.userAgent === undefined ? BROWSER_USER_AGENT : options.userAgent;

  // Consecutive runs sharing a key, exactly as load.ts groups them: an identify()
  // has to arrive before the events that depend on its traits.
  let group: SimMessage[] = [];
  let serverSide = messages[0]?.serverSide ?? false;

  const flush = async () => {
    if (group.length === 0) return;
    const receivedAt = group.reduce(
      (latest, message) => (deliveredAt(message) > latest ? deliveredAt(message) : latest),
      new Date(0),
    );

    const response = await handleBatch({
      body: JSON.stringify({
        batch: group.map((message) => message.message),
        sentAt: receivedAt.toISOString(),
      }),
      headers: {
        authorization: `Bearer ${serverSide ? keys.secret : keys.publishable}`,
        'content-type': 'application/json',
        ...(userAgent === null ? {} : { 'user-agent': userAgent }),
      },
      receivedAt,
    });

    const body = response.body as { results?: { status: string; code: string }[] };
    for (const item of body.results ?? []) {
      if (item.status === 'ok') tally.ok += 1;
      else if (item.status === 'duplicate') tally.duplicate += 1;
      else if (item.status === 'filtered') tally.filtered += 1;
      else tally.errors[item.code] = (tally.errors[item.code] ?? 0) + 1;
    }
    group = [];
  };

  for (const message of messages) {
    if (message.serverSide !== serverSide || group.length >= SEND_BATCH_SIZE) {
      await flush();
      serverSide = message.serverSide;
    }
    group.push(message);
  }
  await flush();

  return tally;
}

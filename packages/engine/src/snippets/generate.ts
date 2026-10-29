/**
 * The AI-coder prompt generator (brief §9).
 *
 * "The founder picks a language and framework; the generator outputs code for that
 * stack using our library, Segment's library pointed at our host (always setting the
 * host; PHP in its forked-curl or file mode), or plain HTTP. It uses the canonical
 * event names, shows the exact places to call them, and follows the project's funnel
 * config."
 *
 * Pure, and it takes the project's own funnel as an argument — so the output names
 * the founder's real steps rather than a generic example. That is the difference
 * between a snippet someone pastes and one they have to translate first.
 */

export const SNIPPET_STACKS = [
  'next-app-router',
  'node-express',
  'python-django',
  'python-flask',
  'ruby-rails',
  'php-laravel',
  'go-net-http',
  'plain-http',
] as const;
export type SnippetStack = (typeof SNIPPET_STACKS)[number];

export const SNIPPET_LIBRARIES = [
  /** Our own npm package, `dripmetric`. */
  'dripmetric',
  /** Segment's library for that language, pointed at our host. */
  'segment',
  /** A bare HTTP call: no dependency at all. */
  'http',
] as const;
export type SnippetLibrary = (typeof SNIPPET_LIBRARIES)[number];

export interface SnippetStep {
  /** The founder's own label, e.g. "Connect a data source". */
  label: string;
  /** The canonical event that completes it. */
  eventName: string;
  position: number;
}

export interface SnippetInput {
  stack: SnippetStack;
  library: SnippetLibrary;
  /** The ingest host, e.g. https://app.dripmetric.com. */
  host: string;
  publishableKey: string;
  /** Shown as a placeholder: a secret key must never be printed to a screen. */
  secretKeyPlaceholder?: string;
  steps: readonly SnippetStep[];
  /** Which canonical event means someone paid, when the founder has confirmed one. */
  paidEvent: string | null;
}

export interface GeneratedSnippet {
  stack: SnippetStack;
  library: SnippetLibrary;
  /** The language for syntax highlighting. */
  language: string;
  /** The install line, if the choice needs a dependency. */
  install: string | null;
  code: string;
  /** The prompt to hand an AI coding agent, which is the point of the feature. */
  prompt: string;
  /** Anything the founder must know for this combination to work. */
  notes: string[];
}

/** Which language each stack is written in. */
const LANGUAGES: Record<SnippetStack, string> = {
  'next-app-router': 'typescript',
  'node-express': 'javascript',
  'python-django': 'python',
  'python-flask': 'python',
  'ruby-rails': 'ruby',
  'php-laravel': 'php',
  'go-net-http': 'go',
  'plain-http': 'bash',
};

/**
 * Which library choices a stack can actually use.
 *
 * Offering Segment's Go library when it does not exist would produce a snippet that
 * cannot run, and a founder debugging a generated snippet has no way to know whether
 * the bug is theirs.
 */
export function librariesFor(stack: SnippetStack): SnippetLibrary[] {
  switch (stack) {
    case 'next-app-router':
    case 'node-express':
      return ['dripmetric', 'segment', 'http'];
    case 'python-django':
    case 'python-flask':
    case 'ruby-rails':
    case 'php-laravel':
      // No library of ours for these yet, so Segment's or plain HTTP.
      return ['segment', 'http'];
    case 'go-net-http':
    case 'plain-http':
      return ['http'];
  }
}

export function generateSnippet(input: SnippetInput): GeneratedSnippet {
  const language = LANGUAGES[input.stack];
  const notes: string[] = [];

  if (!librariesFor(input.stack).includes(input.library)) {
    notes.push(
      `There is no ${input.library} library for this stack, so this uses plain HTTP instead.`,
    );
  }
  const library = librariesFor(input.stack).includes(input.library) ? input.library : 'http';

  /*
   * ALWAYS set the host. Brief §9 says so twice, and it is the one mistake that
   * silently sends a founder's events to Segment instead of to us.
   */
  if (library === 'segment') {
    notes.push(
      `The host is set explicitly. Segment's libraries default to Segment's own ` +
        `endpoint, and without the host your events go there instead of to us.`,
    );
  }
  if (input.stack === 'php-laravel' && library === 'segment') {
    notes.push(
      `Segment's PHP library needs a consumer: "socket" blocks the request, so use ` +
        `"fork_curl" on a normal server or "file" when you cannot fork, and ship the ` +
        `log yourself.`,
    );
  }

  const code = codeFor(input, library);
  return {
    stack: input.stack,
    library,
    language,
    install: installFor(input.stack, library),
    code,
    prompt: promptFor(input, library, code),
    notes,
  };
}

function installFor(stack: SnippetStack, library: SnippetLibrary): string | null {
  if (library === 'http') return null;
  if (library === 'dripmetric') return 'npm install dripmetric';

  switch (stack) {
    case 'next-app-router':
    case 'node-express':
      return 'npm install @segment/analytics-node';
    case 'python-django':
    case 'python-flask':
      return 'pip install segment-analytics-python';
    case 'ruby-rails':
      return 'bundle add segment-analytics-ruby';
    case 'php-laravel':
      return 'composer require segmentio/analytics-php';
    default:
      return null;
  }
}

/**
 * The step calls, in the founder's own order.
 *
 * This is "shows the exact places to call them": the comment above each call is the
 * founder's own step label, so they can find the line in their own code rather than
 * guessing what "Step 2" meant.
 */
function stepComments(input: SnippetInput, indent = ''): string[] {
  return input.steps.map(
    (step) => `${indent}// Step ${step.position}: ${step.label} -> "${step.eventName}"`,
  );
}

function codeFor(input: SnippetInput, library: SnippetLibrary): string {
  const first = input.steps[0];
  const stepEvent = first?.eventName ?? 'Signed Up';
  const paid = input.paidEvent;

  if (library === 'dripmetric') {
    return input.stack === 'next-app-router'
      ? nextAppRouter(input, stepEvent, paid)
      : nodeExpress(input, stepEvent, paid);
  }
  if (library === 'segment') return segmentCode(input, stepEvent, paid);
  return httpCode(input, stepEvent, paid);
}

function nextAppRouter(input: SnippetInput, stepEvent: string, paid: string | null): string {
  return [
    `// app/layout.tsx — the browser half, mounted once.`,
    `import * as dripmetric from 'dripmetric/browser';`,
    ``,
    `dripmetric.init({`,
    `  key: '${input.publishableKey}',`,
    `  host: '${input.host}',`,
    `});`,
    ``,
    `// app/api/signup/route.ts — the server half. Use your SECRET key here, from an`,
    `// environment variable: a secret key in browser code is a secret no longer.`,
    `import { Dripmetric } from 'dripmetric/server';`,
    ``,
    `const dm = new Dripmetric({`,
    `  secretKey: process.env.DRIPMETRIC_SECRET_KEY!,`,
    `  host: '${input.host}',`,
    `});`,
    ``,
    `export async function POST(request: Request) {`,
    `  const user = await createUser(request);`,
    ``,
    `  // Who they are. Send this once you know.`,
    `  await dm.identify({ userId: user.id, traits: { email: user.email, plan: user.plan } });`,
    ``,
    ...stepComments(input, '  '),
    `  await dm.track({ userId: user.id, event: '${stepEvent}' });`,
    ``,
    paid === null
      ? `  // Once you have a payment event, send it as "Subscription Started" — it is`
      : `  // When they pay, from your billing webhook:`,
    paid === null
      ? `  // what turns "intent but didn't pay" on.`
      : `  // await dm.track({ userId: user.id, event: '${paid}' });`,
    `  return Response.json({ ok: true });`,
    `}`,
  ].join('\n');
}

function nodeExpress(input: SnippetInput, stepEvent: string, paid: string | null): string {
  return [
    `const { Dripmetric } = require('dripmetric/server');`,
    ``,
    `const dm = new Dripmetric({`,
    `  secretKey: process.env.DRIPMETRIC_SECRET_KEY,`,
    `  host: '${input.host}',`,
    `});`,
    ``,
    `app.post('/signup', async (req, res) => {`,
    `  const user = await createUser(req.body);`,
    `  await dm.identify({ userId: user.id, traits: { email: user.email } });`,
    ``,
    ...stepComments(input, '  '),
    `  await dm.track({ userId: user.id, event: '${stepEvent}' });`,
    `  res.json({ ok: true });`,
    `});`,
    ``,
    paid === null
      ? `// Send "Subscription Started" from your billing webhook to turn on the`
      : `// Your billing webhook:`,
    paid === null
      ? `// money figures.`
      : `// await dm.track({ userId: user.id, event: '${paid}' });`,
    ``,
    `// Flush before the process exits, or queued events are lost.`,
    `process.on('SIGTERM', () => dm.flush());`,
  ].join('\n');
}

function segmentCode(input: SnippetInput, stepEvent: string, paid: string | null): string {
  const host = input.host;

  if (input.stack === 'python-django' || input.stack === 'python-flask') {
    return [
      `import segment.analytics as analytics`,
      ``,
      `analytics.write_key = "${input.secretKeyPlaceholder ?? 'YOUR_SECRET_KEY'}"`,
      `# Always set the host. Without it, Segment's library posts to Segment.`,
      `analytics.host = "${host}"`,
      ``,
      `def signup(request):`,
      `    user = create_user(request)`,
      `    analytics.identify(user.id, {"email": user.email})`,
      ``,
      ...stepComments(input, '    '),
      `    analytics.track(user.id, "${stepEvent}")`,
      ``,
      paid === null
        ? `    # Send "Subscription Started" when they pay.`
        : `    # analytics.track(user.id, "${paid}")`,
      `    return ok()`,
    ].join('\n');
  }

  if (input.stack === 'ruby-rails') {
    return [
      `# config/initializers/dripmetric.rb`,
      `Analytics = Segment::Analytics.new(`,
      `  write_key: ENV.fetch("DRIPMETRIC_SECRET_KEY"),`,
      `  # Always set the host, or this posts to Segment instead of to us.`,
      `  host: "${host}",`,
      `  stub: false`,
      `)`,
      ``,
      `# app/controllers/signups_controller.rb`,
      `def create`,
      `  user = User.create!(signup_params)`,
      `  Analytics.identify(user_id: user.id, traits: { email: user.email })`,
      ``,
      ...stepComments(input, '  '),
      `  Analytics.track(user_id: user.id, event: "${stepEvent}")`,
      `end`,
    ].join('\n');
  }

  // PHP: the consumer choice is the thing that bites.
  return [
    `<?php`,
    `use Segment\\Segment;`,
    ``,
    `Segment::init(getenv('DRIPMETRIC_SECRET_KEY'), [`,
    `  // Always set the host.`,
    `  'host' => '${host}',`,
    `  // "socket" blocks the request. Use fork_curl on a normal server; use "file"`,
    `  // and ship the log yourself if your host cannot fork.`,
    `  'consumer' => 'fork_curl',`,
    `]);`,
    ``,
    `Segment::identify(['userId' => $user->id, 'traits' => ['email' => $user->email]]);`,
    ``,
    ...stepComments(input),
    `Segment::track(['userId' => $user->id, 'event' => '${stepEvent}']);`,
    ``,
    `// fork_curl returns before the request finishes; flush at the end anyway.`,
    `Segment::flush();`,
  ].join('\n');
}

function httpCode(input: SnippetInput, stepEvent: string, paid: string | null): string {
  const key = input.secretKeyPlaceholder ?? 'YOUR_SECRET_KEY';

  if (input.stack === 'go-net-http') {
    return [
      `// One POST, no dependency. The key goes in the Authorization header.`,
      `//`,
      `// messageId is REQUIRED and is the dedupe key: generate a fresh one per event.`,
      `// Send the same id twice and the second is ignored, which is what makes a`,
      `// retry safe.`,
      `body, _ := json.Marshal(map[string]any{`,
      `  "batch": []map[string]any{{`,
      `    "type":      "track",`,
      `    "messageId": uuid.NewString(),`,
      `    "userId":    user.ID,`,
      `    "event":     "${stepEvent}",`,
      `  }},`,
      `})`,
      ``,
      `req, _ := http.NewRequest("POST", "${input.host}/v1/batch", bytes.NewReader(body))`,
      `req.Header.Set("Authorization", "Bearer "+os.Getenv("DRIPMETRIC_SECRET_KEY"))`,
      `req.Header.Set("Content-Type", "application/json")`,
      `http.DefaultClient.Do(req)`,
    ].join('\n');
  }

  /*
   * `messageId` is REQUIRED, and leaving it out was a real bug.
   *
   * The first version of this snippet omitted it, so a founder pasting the curl got
   * `invalid_message` three times and no events — the worst possible first impression.
   * It is also the dedupe key, which is why the comment says to generate a fresh one
   * rather than copying the example id.
   */
  return [
    `# One POST, no dependency. Works from anything that can make an HTTP request.`,
    `#`,
    `# messageId is required, and it is the dedupe key: generate a fresh one per`,
    `# event (a uuid is ideal). Sending the same id twice is ignored, which is what`,
    `# makes a retry safe.`,
    `curl -X POST ${input.host}/v1/batch \\`,
    `  -H "Authorization: Bearer ${key}" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '{`,
    `    "batch": [`,
    `      { "type": "identify", "messageId": "msg-1-change-me", "userId": "user_123",`,
    `        "traits": { "email": "jo@example.com" } },`,
    `      { "type": "track", "messageId": "msg-2-change-me", "userId": "user_123",`,
    `        "event": "${stepEvent}" }` + (paid === null ? '' : ','),
    ...(paid === null
      ? []
      : [
          `      { "type": "track", "messageId": "msg-3-change-me", "userId": "user_123",`,
          `        "event": "${paid}" }`,
        ]),
    `    ]`,
    `  }'`,
  ].join('\n');
}

/**
 * The prompt itself.
 *
 * Written to be pasted into an AI coding agent, which means it has to carry the
 * things such an agent cannot guess: the exact canonical names, the project's own
 * steps, and the two rules that are easy to get wrong (never put a secret key in
 * browser code; always set the host).
 */
function promptFor(input: SnippetInput, library: SnippetLibrary, code: string): string {
  const steps = input.steps
    .map(
      (step) =>
        `  ${step.position}. "${step.label}" is complete when you send "${step.eventName}".`,
    )
    .join('\n');

  return [
    `Add Dripmetric product analytics to this ${input.stack} codebase.`,
    ``,
    `Use ${
      library === 'dripmetric'
        ? 'the `dripmetric` npm package'
        : library === 'segment'
          ? "Segment's analytics library, with the host set to our endpoint"
          : 'plain HTTP requests, with no new dependency'
    }.`,
    ``,
    `Rules that matter:`,
    `- Send events with EXACTLY these names. They are canonical; a renamed event will`,
    `  not be understood: ${canonicalNames(input).join(', ')}.`,
    `- The secret key is server-side only. Never import it into browser code, and read`,
    `  it from an environment variable, never a literal.`,
    `- Set the host to ${input.host} explicitly.${
      library === 'segment' ? " Segment's libraries otherwise post to Segment." : ''
    }`,
    `- Call identify() as soon as you know who the user is, with their email as a trait.`,
    library === 'http'
      ? `- Every message needs a unique messageId. It is the dedupe key, so generate one\n  per event and a retry becomes safe rather than a double count.`
      : `- The library generates messageIds for you; do not set them by hand.`,
    ``,
    `This product's funnel, in order:`,
    steps === '' ? '  (no steps confirmed yet — ask before inventing any)' : steps,
    ``,
    input.paidEvent === null
      ? `No paid event is configured yet. If this codebase has billing, send`
      : `When a payment succeeds, send "${input.paidEvent}".`,
    input.paidEvent === null
      ? `"Subscription Started" from the server when a payment succeeds.`
      : ``,
    ``,
    `Here is a working starting point. Put each call where that thing actually happens`,
    `in this codebase rather than keeping it all in one file:`,
    ``,
    '```',
    code,
    '```',
  ]
    .filter((line) => line !== undefined)
    .join('\n');
}

function canonicalNames(input: SnippetInput): string[] {
  const names = input.steps.map((step) => step.eventName);
  if (input.paidEvent !== null) names.push(input.paidEvent);
  return names.length > 0 ? [...new Set(names)] : ['Signed Up', 'Subscription Started'];
}

import { NextResponse } from 'next/server';
import { handleSourceWebhook, IngestError, type AdapterSource } from '@dripmetric/ingest';

/**
 * POST /v1/sources/:kind/:publicId — the no-code feeds (brief §5, M12).
 *
 * A thin adapter, like every other route here: it reads the RAW body (a signature is
 * over bytes, and re-serialising a parsed object would change them), hands it to the
 * ingest package and translates the result.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const KINDS: AdapterSource[] = ['segment', 'rudderstack', 'posthog'];

export async function POST(
  request: Request,
  context: { params: Promise<{ kind: string; publicId: string }> },
): Promise<Response> {
  const { kind, publicId } = await context.params;
  if (!KINDS.includes(kind as AdapterSource)) {
    return NextResponse.json(
      { error: { code: 'not_found', message: 'Unknown source kind.' } },
      { status: 404 },
    );
  }

  const rawBody = await request.text();
  const headers: Record<string, string | undefined> = {};
  request.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  try {
    const response = await handleSourceWebhook(kind as AdapterSource, publicId, {
      rawBody,
      headers,
      receivedAt: new Date(),
    });
    return NextResponse.json(response.body, { status: response.status });
  } catch (error) {
    if (error instanceof IngestError) {
      return NextResponse.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status },
      );
    }
    throw error;
  }
}

/**
 * POST /api/osrs-data/pair — the plugin exchanges a 5-digit code for a device token (handoff §3.1,
 * §6.2). Everything is decided by handlePair (@hub/server): decommission switch (410, D-56), rate
 * limits (429 + integer Retry-After, PLUGIN-5), code format, version gate, consume. Every non-2xx
 * carries a JSON `error` the plugin shows in its pairing dialog. GET/HEAD answer 400 with a hint
 * instead of anything that could redirect (D-38, PLUGIN-2).
 */
import { PAIR_MESSAGES, getLogger, handlePair } from '@hub/server';
import { PAIR_MAX_BODY_BYTES, pairDeps, pluginGetResponse } from '@/lib/deps';
import { clientIp, json, pluginResponse, readBodyCapped } from '@/lib/http';

export async function POST(request: Request): Promise<Response> {
  let body: string | null;
  try {
    // Over the cap → null → "Missing or malformed pairing code" (400).
    body = await readBodyCapped(request, PAIR_MAX_BODY_BYTES);
  } catch {
    body = null; // the client went away mid-body; nobody reads the answer
  }
  try {
    const result = await handlePair(pairDeps(), {
      versionHeader: request.headers.get('x-osrs-exporter-version'),
      ip: clientIp(request),
      body,
    });
    return pluginResponse(result);
  } catch (err) {
    // handlePair maps its own failures; this is a broken deployment (config, DATABASE_URL unset).
    getLogger().error(
      { errName: err instanceof Error ? err.name : typeof err },
      'pair: setup failed',
    );
    return json(500, { ok: false, error: PAIR_MESSAGES.failed });
  }
}

export async function GET(request: Request): Promise<Response> {
  return pluginGetResponse(request, 'pair');
}

export async function HEAD(request: Request): Promise<Response> {
  return pluginGetResponse(request, 'pair');
}

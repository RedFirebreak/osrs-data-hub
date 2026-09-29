/**
 * POST /api/osrs-data/events — plugin ingest (handoff §7, ARCHITECTURE §6). handleIngest
 * (@hub/server) decides everything and never throws; this route only adapts HTTP: the headers, the
 * client IP (D-42), and a body reader with a hard cap enforced while streaming (413, NEXT-4). The
 * content type is not checked at all: the plugin sends `application/json; charset=utf-8` (handoff
 * §3.1). The plugin reads only the status and Retry-After, which pluginResponse copies (PLUGIN-5).
 * GET/HEAD answer 400 with a hint, never a redirect (D-38, PLUGIN-2).
 */
import { getLogger, handleIngest } from '@hub/server';
import { ingestDeps, pluginGetResponse } from '@/lib/deps';
import { clientIp, json, pluginResponse, readBodyCapped } from '@/lib/http';

export async function POST(request: Request): Promise<Response> {
  let deps;
  try {
    deps = ingestDeps();
  } catch (err) {
    // A broken deployment (config, DATABASE_URL unset): 500 makes the plugin back off and retry.
    getLogger().error(
      { errName: err instanceof Error ? err.name : typeof err },
      'ingest: setup failed',
    );
    return json(500, { ok: false, error: 'internal_error' });
  }
  const result = await handleIngest(deps, {
    token: request.headers.get('x-osrs-token'),
    versionHeader: request.headers.get('x-osrs-exporter-version'),
    ip: clientIp(request),
    readBody: (maxBytes) => readBodyCapped(request, maxBytes),
  });
  return pluginResponse(result);
}

export async function GET(request: Request): Promise<Response> {
  return pluginGetResponse(request, 'events');
}

export async function HEAD(request: Request): Promise<Response> {
  return pluginGetResponse(request, 'events');
}

/**
 * Dependencies of the plugin endpoints (POST /api/osrs-data/pair and /events), built per request
 * from the process-wide singletons. The rate limiters are in memory in the single web process (D-5)
 * and live on globalThis: route handlers, RSC and instrumentation are separate module instances in
 * Next, and a module-level limiter would exist once per instance (NEXT-3, D-37).
 */
import { getConfig, type TokenBucketLimiter } from '@hub/core';
import { getDb, pgErrorCode } from '@hub/db';
import {
  authenticateDevice,
  createIngestLimiter,
  createPairLimits,
  getLogger,
  getMetrics,
  isDecommissioned,
  type IngestDeps,
  type PairDeps,
  type PairLimits,
} from '@hub/server';
import { json } from './http';

const g = globalThis as unknown as {
  __hubIngestLimiter?: TokenBucketLimiter;
  __hubPairLimits?: PairLimits;
};

/** The per-device token bucket for snapshot-only payloads (handoff §7.6). */
export function getIngestLimiter(): TokenBucketLimiter {
  g.__hubIngestLimiter ??= createIngestLimiter();
  return g.__hubIngestLimiter;
}

/** Per-client, global and lockout limits of /pair (handoff §6.2.7). */
export function getPairLimits(): PairLimits {
  g.__hubPairLimits ??= createPairLimits();
  return g.__hubPairLimits;
}

/** Forgets both limiters (tests; see lib/test-utils.ts). */
export function resetPluginLimitsForTests(): void {
  delete g.__hubIngestLimiter;
  delete g.__hubPairLimits;
}

/** handleIngest's dependencies. isDecommissioned is cached for 10 s by @hub/server. */
export function ingestDeps(): IngestDeps {
  const config = getConfig();
  const { db } = getDb(config.databaseUrl);
  return {
    db,
    minPluginVersion: config.minPluginVersion,
    maxBodyBytes: config.ingestMaxBodyBytes,
    limiter: getIngestLimiter(),
    logger: getLogger(),
    metrics: getMetrics(),
    isDecommissioned: () => isDecommissioned(db),
  };
}

/** handlePair's dependencies, with the decommission switch (410 before anything else, D-56). */
export function pairDeps(): PairDeps {
  const config = getConfig();
  const { db } = getDb(config.databaseUrl);
  return {
    db,
    minPluginVersion: config.minPluginVersion,
    hubName: config.hubName,
    limits: getPairLimits(),
    logger: getLogger(),
    metrics: getMetrics(),
    isDecommissioned: () => isDecommissioned(db),
  };
}

/** Largest /pair body read: `{"code":"12345"}` is 16 bytes. */
export const PAIR_MAX_BODY_BYTES = 8 * 1024;

/**
 * What GET/HEAD on a plugin endpoint answers (D-38). The plugin shows this text in its pairing
 * dialog: a GET here usually means a redirect (http→https, www, a trailing slash) turned its POST into
 * a GET, which silently drops every payload from then on (PLUGIN-2).
 */
export const PLUGIN_GET_ERROR =
  'This URL only accepts the HA Exporter plugin. In RuneLite, enter the hub URL exactly as shown in the pairing wizard, including https://.';

/**
 * 400 `{"ok":false,"error":PLUGIN_GET_ERROR}` for GET/HEAD on /api/osrs-data/* (never a redirect,
 * PLUGIN-2); HEAD gets the same status and headers without a body. A GET that carries the token of
 * a paired device (not revoked, its user active: authenticateDevice) is a plugin behind a redirect:
 * logged with the device id (never the token), so an admin can find it. Unknown tokens are not
 * logged: anyone can send those, as often as they like.
 */
export function pluginGetResponse(request: Request, endpoint: 'pair' | 'events'): Response {
  const token = request.headers.get('x-osrs-token');
  if (token) void logMisdirectedPlugin(token, endpoint);
  const res = json(400, { ok: false, error: PLUGIN_GET_ERROR });
  return request.method === 'HEAD'
    ? new Response(null, { status: 400, headers: res.headers })
    : res;
}

async function logMisdirectedPlugin(token: string, endpoint: 'pair' | 'events'): Promise<void> {
  const log = getLogger();
  try {
    const { db } = getDb(getConfig().databaseUrl);
    const device = await authenticateDevice(db, token);
    if (!device) return;
    log.warn(
      { endpoint, deviceId: device.id, userId: device.userId },
      'plugin request arrived as GET: its URL is being redirected (PLUGIN-2)',
    );
  } catch (err) {
    log.debug(
      { endpoint, pgCode: pgErrorCode(err) },
      'plugin GET: device lookup failed (PLUGIN-2)',
    );
  }
}

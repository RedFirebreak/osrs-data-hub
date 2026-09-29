/**
 * The one wrapper every authenticated /api/v1 handler runs in (handoff §13, D-70..D-72):
 *
 *   export async function GET(request: Request) {
 *     return withApiKey(request, async ({ db, principal }) => v1Ok(wireMe(await apiMe(db, principal))));
 *   }
 *
 * In this order:
 * 1. Bearer keys only: cookies are never read (no session lookup), so a signed-in browser gets no
 *    access it didn't ask for (D-71).
 * 2. The failed-authentication limit per client IP (D-72): an IP already over it gets 429 +
 *    Retry-After before anything touches the database, so keys can't be guessed.
 * 3. authenticateApiKey: every failure is the same 401 (`WWW-Authenticate: Bearer`), whatever was
 *    wrong, and every one but a missing header counts towards the IP's limit.
 * 4. The per-key limits (120/min, plus 1/s on /snapshot): 429 + Retry-After; the X-RateLimit-* headers
 *    go on every authenticated response, errors included.
 * 5. The handler, inside handleApi's error mapping (ZodError/ServerApiError → 400/404, database outage
 *    → 503 + Retry-After, anything else → 500 that leaks nothing).
 * Every response gets the CORS headers (cors.ts), and every request counts in the hub_api_* metrics
 * (metrics.ts): its route group and status, its duration, and a 429's limit or a 401's reason.
 *
 * Only the request's own properties are read (headers, url); it is never copied with
 * `new Request(request, …)`, which fails on Node 24 behind Next's request proxy (NEXT-13).
 *
 * The limiters live on globalThis: route handlers and pages are separate module instances in Next,
 * and the limits must be one per process (NEXT-3, D-37). Retry-After is always an integer (PLUGIN-5
 * applies to any client that parses it strictly).
 */
import { getDb, type Db } from '@hub/db';
import {
  authenticateApiKey,
  checkApiRate,
  checkAuthFailures,
  createApiLimits,
  getMetrics,
  recordAuthFailure,
  type ApiLimits,
  type ApiPrincipal,
  type ApiRateHeaders,
} from '@hub/server';
import { connection } from 'next/server';
import { clientIp, handleApi } from '@/lib/http';
import { withCors } from './cors';
import { apiRouteGroup, measureApiRequest } from './metrics';
import { v1Error } from './respond';

const g = globalThis as unknown as { __hubApiLimits?: ApiLimits };

/** The process's API limiters (NEXT-3). */
export function getApiLimits(): ApiLimits {
  g.__hubApiLimits ??= createApiLimits();
  return g.__hubApiLimits;
}

/** Replaces (tests: a controllable clock) or forgets the limiters. */
export function setApiLimitsForTests(limits?: ApiLimits): void {
  if (limits) g.__hubApiLimits = limits;
  else delete g.__hubApiLimits;
}

/** The same body for every refused key, so a caller can't tell which part was wrong (D-70). */
export const UNAUTHORIZED_MESSAGE =
  'A valid API key is required: send it as "Authorization: Bearer ohub_<prefix>_<secret>".';

export interface ApiKeyContext {
  db: Db;
  principal: ApiPrincipal;
}

export async function withApiKey(
  request: Request,
  handler: (ctx: ApiKeyContext) => Promise<Response>,
  opts: { snapshot?: boolean } = {},
): Promise<Response> {
  const done = measureApiRequest(apiRouteGroup(request.url));
  const rate: { headers?: ApiRateHeaders } = {};
  const res = await handleApi(async () => {
    await connection();
    const limits = getApiLimits();
    const ip = clientIp(request) ?? 'unknown';
    const gate = checkAuthFailures(limits, ip);
    if (!gate.ok) return rateLimited('auth_ip', gate.retryAfterSeconds);

    const { db } = getDb();
    const auth = await authenticateApiKey(db, request.headers.get('authorization'));
    if (!auth.ok) {
      getMetrics().apiAuthFailures.inc({ reason: auth.reason });
      if (auth.reason !== 'missing') recordAuthFailure(limits, ip);
      return v1Error(401, 'unauthorized', UNAUTHORIZED_MESSAGE, { 'WWW-Authenticate': 'Bearer' });
    }

    const limit = checkApiRate(limits, auth.principal.keyId, { snapshot: opts.snapshot === true });
    rate.headers = limit.headers;
    if (!limit.ok) return rateLimited(limit.limit ?? 'key', limit.retryAfterSeconds);
    return handler({ db, principal: auth.principal });
  });
  return done(withCors(res, rate.headers ? { ...rate.headers } : {}));
}

function rateLimited(limit: 'key' | 'snapshot' | 'auth_ip', retryAfterSeconds: number): Response {
  getMetrics().apiRateLimited.inc({ limit });
  const seconds = Math.max(1, Math.ceil(retryAfterSeconds));
  return v1Error(429, 'rate_limited', `Too many requests: retry in ${seconds} s.`, {
    'Retry-After': String(seconds),
  });
}

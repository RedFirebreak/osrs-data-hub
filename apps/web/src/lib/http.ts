/**
 * HTTP helpers for the route handlers (Node runtime). Every app mutation is a route handler under
 * /api/app/* (D-36, no Server Actions), written like this:
 *
 *   export async function POST(request: Request) {
 *     return handleApi(async () => {
 *       assertSameOrigin(request);                        // CSRF (handoff §16)
 *       const { user } = await requireApiUser(request);  // 401 unless signed in and active
 *       const body = await readJson(request);            // 400 invalid_json / 413 too large
 *       …
 *       return json(200, { ok: true });
 *     });
 *   }
 *
 * handleApi turns thrown ApiError/SharingError/AdminError/SelfDeleteError/ZodError (and the public
 * API's ServerApiError/ApiKeyError from @hub/server) into JSON 4xx `{ error: { code, message } }`, transient
 * database errors into 503 + Retry-After, and anything else into a 500 that leaks nothing. Absolute URLs are never built from request.url (NEXT-2): use
 * getConfig().appOrigin.
 */
import { clientIpFromHeaders, getConfig } from '@hub/core';
import { isDataDbError, isTransientDbError, pgErrorCode, safeDbErrorMessage } from '@hub/db';
import {
  AdminError,
  ApiKeyError,
  ApiError as ServerApiError,
  GoalError,
  SelfDeleteError,
  SharingError,
  getLogger,
  type PluginResponse,
} from '@hub/server';
import { isAPIError as isAuthApiError } from 'better-auth/api';
import { unstable_rethrow } from 'next/navigation';
import { ZodError } from 'zod';

const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

/** Retry-After (whole seconds, PLUGIN-5) for transient database failures on app routes. */
const API_RETRY_AFTER_SECONDS = 5;

/** Default cap for JSON bodies of app routes (readJson). */
const API_MAX_BODY_BYTES = 64 * 1024;

/**
 * A JSON response: `content-type: application/json; charset=utf-8` and `cache-control: no-store`
 * (unless `headers` sets its own cache-control).
 */
export function json(status: number, body: unknown, headers?: HeadersInit): Response {
  const h = new Headers(headers);
  h.set('content-type', JSON_CONTENT_TYPE);
  if (!h.has('cache-control')) h.set('cache-control', 'no-store');
  return new Response(JSON.stringify(body), { status, headers: h });
}

/**
 * The Response for a plugin endpoint result. Its headers are copied as given, so Retry-After stays
 * the integer delta-seconds the plugin understands (PLUGIN-5), and the pairing token's no-store too.
 */
export function pluginResponse(r: PluginResponse): Response {
  return json(r.status, r.body, r.headers);
}

/**
 * Reads the request body as UTF-8 text with a hard cap of `maxBytes`; resolves null when the body is
 * larger. A declared Content-Length over the cap is refused without reading; otherwise the bytes are
 * counted while streaming and the reader is cancelled as soon as the cap is passed, so a chunked body
 * can't make the process buffer more than `maxBytes` (+ one chunk). No body → ''. Invalid UTF-8
 * becomes U+FFFD (like Request.text()); a leading BOM is dropped.
 *
 * A failed read (the client went away mid-body) rejects. Note: this only bounds memory if no
 * `proxy.ts` matches the route — Next buffers (and silently truncates) bodies for every path a proxy
 * matches (NEXT-4). There is no proxy.ts; keep /api/osrs-data, /api/v1 and /api/live out of any
 * matcher if one is ever added.
 */
export async function readBodyCapped(request: Request, maxBytes: number): Promise<string | null> {
  const body = request.body;
  const declared = contentLength(request.headers);
  if (declared !== null && declared > maxBytes) {
    await body?.cancel().catch(() => {});
    return null;
  }
  if (!body) return '';

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8').decode(bytes);
}

/** Content-Length as a number, or null when absent or not a plain non-negative integer. */
function contentLength(headers: Headers): number | null {
  const raw = headers.get('content-length')?.trim();
  if (!raw || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * The request body parsed as JSON, capped at `maxBytes` (default 64 KiB). Throws ApiError 413 when
 * larger and 400 `invalid_json` when it isn't JSON; a request without a body is not JSON either,
 * unless `emptyAs` says what it counts as (`{}` for a route whose body is optional). Validate the
 * result with zod (ZodError → 400).
 */
export async function readJson(
  request: Request,
  opts: { maxBytes?: number; emptyAs?: unknown } = {},
): Promise<unknown> {
  const text = await readBodyCapped(request, opts.maxBytes ?? API_MAX_BODY_BYTES);
  if (text === null) throw new ApiError(413, 'payload_too_large', 'The request body is too large.');
  if (opts.emptyAs !== undefined && text.trim() === '') return opts.emptyAs;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApiError(400, 'invalid_json', 'The request body is not valid JSON.');
  }
}

/**
 * The client's IP: the X-Forwarded-For entry TRUST_PROXY_HOPS from the right (D-42), null when
 * unknown. Next 16 has no request.ip.
 */
export function clientIp(request: Request): string | null {
  return clientIpFromHeaders(request.headers, getConfig().trustProxyHops);
}

/**
 * True when the request comes from a page of this hub: its Origin header is APP_URL's origin, or,
 * when a browser sent no Origin, `Sec-Fetch-Site: same-origin`. A request with neither is refused
 * (browsers send Origin on every POST/PUT/PATCH/DELETE fetch).
 */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (origin !== null) {
    let parsed: string;
    try {
      parsed = new URL(origin).origin;
    } catch {
      return false; // "null" (opaque origins) and garbage
    }
    return parsed === getConfig().appOrigin;
  }
  return request.headers.get('sec-fetch-site') === 'same-origin';
}

/**
 * CSRF check for every /api/app/* mutation (handoff §16): throws ApiError 403 `bad_origin` unless
 * isSameOrigin(request). Compared with APP_URL, never with request.url or Host (NEXT-2).
 */
export function assertSameOrigin(request: Request): void {
  if (!isSameOrigin(request)) {
    throw new ApiError(403, 'bad_origin', 'This request must come from the hub itself.');
  }
}

/**
 * An error a route throws on purpose; handleApi answers `status` with
 * `{ error: { code, message } }` (plus `details`, when given). The message is shown to users: never
 * put data, ids of things the viewer may not see, or tokens in it.
 */
export class ApiError extends Error {
  override name = 'ApiError';

  constructor(
    readonly status: number,
    readonly code: string,
    message: string = code,
    readonly headers?: Record<string, string>,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

/**
 * The one 404 for an account, for the UI's routes and the public API alike: an unknown id, an id
 * that can't be one, an account the viewer or key can't see and one whose category they can't read
 * all look exactly alike (D-70), so existence never leaks.
 */
export function accountNotFound(): ApiError {
  return new ApiError(404, 'not_found', 'Account not found.');
}

const TYPED_ERROR_STATUS = { not_found: 404, forbidden: 403, invalid: 400 } as const;

/**
 * Runs a route's body and maps what it throws to JSON:
 * - ApiError → its status; SharingError/AdminError/SelfDeleteError → 404/403/400 by code (their
 *   messages are safe);
 * - the public API's errors from @hub/server (imported as ServerApiError, its name clashes with ours):
 *   `invalid` → 400 `invalid_request`, `not_found` → 404 `not_found` (an account named in a list
 *   parameter that the key can't read, answered like an unknown one, D-70); ApiKeyError `invalid` →
 *   400 `invalid_request` with its field `issues` as `details`, `limit` → 409 `limit`, `conflict` →
 *   409 `conflict` (the key's status doesn't allow it, D-111), `not_found` → 404 (their messages only repeat the request, so they are safe to show); GoalError (D-109) →
 *   404/403/400 by code and `limit` → 409;
 * - ZodError → 400 `invalid_request` with `details: [{ path, message }]` (field errors);
 * - a transient database error (lock timeout 55P03, connection loss, …) → 503 + Retry-After, and so
 *   is a Better Auth 5xx: its session lookup (requireApiUser) turns a database outage into a bare
 *   500 APIError `FAILED_TO_GET_SESSION` without the cause (AUTH-13); a Better Auth 401 → 401;
 * - a data error from the database (SQLSTATE 22/23/54, e.g. a malformed uuid) → 400;
 * - anything else → 500 `internal_error`.
 * Next's own control-flow errors (redirect(), notFound(), a prerender bailout) are rethrown. Database
 * errors are logged by SQLSTATE and the parameter-free message only (DB-3).
 */
export async function handleApi(fn: () => Response | Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    unstable_rethrow(err);
    return errorResponse(err);
  }
}

/** The JSON Response handleApi returns for `err`. */
function errorResponse(err: unknown): Response {
  if (err instanceof ApiError) {
    return errorJson(err.status, err.code, err.message, err.headers, err.details);
  }
  if (err instanceof SharingError || err instanceof AdminError || err instanceof SelfDeleteError) {
    return errorJson(TYPED_ERROR_STATUS[err.code], err.code, err.message);
  }
  if (err instanceof GoalError) {
    return errorJson(
      err.code === 'limit' ? 409 : TYPED_ERROR_STATUS[err.code],
      err.code,
      err.message,
    );
  }
  if (err instanceof ServerApiError) {
    return err.code === 'not_found'
      ? errorJson(404, 'not_found', err.message)
      : errorJson(400, 'invalid_request', err.message);
  }
  if (err instanceof ApiKeyError) {
    switch (err.code) {
      case 'invalid':
        return errorJson(
          400,
          'invalid_request',
          err.message,
          undefined,
          err.issues.length > 0 ? err.issues : undefined,
        );
      case 'limit':
        return errorJson(409, 'limit', err.message);
      case 'conflict':
        return errorJson(409, 'conflict', err.message);
      case 'not_found':
        return errorJson(404, 'not_found', err.message);
    }
  }
  if (err instanceof ZodError) {
    const details = err.issues.map((issue) => ({
      path: issue.path.map(String).join('.'),
      message: issue.message,
    }));
    return errorJson(400, 'invalid_request', 'The request is invalid.', undefined, details);
  }
  const log = getLogger();
  if (isAuthApiError(err)) {
    const status = typeof err.statusCode === 'number' ? err.statusCode : 500;
    const code = (err.body as { code?: unknown } | undefined)?.code;
    if (status === 401) return errorJson(401, 'unauthorized', 'Sign in to the hub first.');
    if (status >= 500) {
      // Better Auth has logged the cause itself; it doesn't hand it on.
      log.warn({ authCode: typeof code === 'string' ? code : undefined }, 'api: auth unavailable');
      return unavailable();
    }
    return errorJson(status, 'invalid_request', 'The request is invalid.');
  }
  const pgCode = pgErrorCode(err);
  if (isTransientDbError(err)) {
    log.warn({ pgCode, error: safeDbErrorMessage(err) }, 'api: transient database error');
    return unavailable();
  }
  if (isDataDbError(err)) {
    log.warn({ pgCode, error: safeDbErrorMessage(err) }, 'api: request rejected by the database');
    return errorJson(400, 'invalid_request', 'The request is invalid.');
  }
  // DB-3: a query error's message and stack carry every bound parameter; log them only for errors
  // that don't wrap a driver error.
  const wrapped = err instanceof Error && err.cause !== undefined;
  log.error(
    {
      errName: err instanceof Error ? err.name : typeof err,
      pgCode,
      error: safeDbErrorMessage(err),
      stack: err instanceof Error && !wrapped ? err.stack : undefined,
    },
    'api: unhandled error',
  );
  return errorJson(500, 'internal_error', 'Something went wrong on the hub.');
}

/** 503 + Retry-After (whole seconds, PLUGIN-5): the client may simply try again. */
function unavailable(): Response {
  return errorJson(503, 'unavailable', 'The hub is busy, try again in a moment.', {
    'Retry-After': String(API_RETRY_AFTER_SECONDS),
  });
}

/** An error response `{ error: { code, message } }`, plus `details` when given. */
export function errorJson(
  status: number,
  code: string,
  message: string,
  headers?: Record<string, string>,
  details?: unknown,
): Response {
  const error = details === undefined ? { code, message } : { code, message, details };
  return json(status, { error }, headers);
}

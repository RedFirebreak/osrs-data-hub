/**
 * How the browser talks to the hub's own routes (/api/app/*, D-36): one request function and one
 * place that turns a failed answer into the text to show. No React, no browser APIs beyond `fetch`;
 * unit-tested in api-client.test.ts. The hook around it (pending flag, error text, the refresh after
 * a 401) is useApiRequest.
 *
 * - `sendJson` never throws: an answer comes back as `{ ok, status, body }` with the parsed JSON body
 *   (null when there is none), and a request that got no answer at all as status 0 (NO_RESPONSE).
 * - `failureMessage` is the same for every feature: no answer and 401 have one text each, and the
 *   hub's own `error.message` is shown for the statuses where it is written for the user. A feature
 *   keeps its own wording through FailureOptions.
 */
import { isRecord } from './guards';

/** Shown when the request got no answer (offline, DNS, the hub is down). */
export const UNREACHABLE_MESSAGE = "Couldn't reach the hub. Check your connection and try again.";

/** Shown for a 401: the session expired or was ended elsewhere. */
export const SESSION_ENDED_MESSAGE = 'Your session has ended. Sign in again.';

/** The `status` of a request that got no answer. */
export const NO_RESPONSE = 0;

export interface ApiRequestInit {
  /** GET when left out. */
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Sent as the JSON body. */
  json?: unknown;
}

export interface ApiResult {
  /** A 2xx answer. */
  ok: boolean;
  /** The HTTP status, or NO_RESPONSE. */
  status: number;
  /** The parsed JSON body; null when there is none or it isn't JSON. */
  body: unknown;
}

/**
 * One same-origin request to an /api/app route. The browser adds the cookie and the Origin header the
 * route checks (D-36).
 */
export async function sendJson(path: string, init: ApiRequestInit = {}): Promise<ApiResult> {
  try {
    const res = await fetch(path, {
      method: init.method ?? 'GET',
      credentials: 'same-origin',
      headers: init.json === undefined ? undefined : { 'content-type': 'application/json' },
      body: init.json === undefined ? undefined : JSON.stringify(init.json),
    });
    const body: unknown = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, body };
  } catch {
    return { ok: false, status: NO_RESPONSE, body: null };
  }
}

/** The `error.message` of an API error body (handleApi's shape), else `fallback`. */
export function apiErrorMessage(body: unknown, fallback: string): string {
  if (isRecord(body) && isRecord(body.error)) {
    const { message } = body.error;
    if (typeof message === 'string' && message.trim() !== '') return message;
  }
  return fallback;
}

/** The `error.details` of a 400 body (handleApi's ZodError shape), else undefined. */
export function apiErrorDetails(body: unknown): unknown {
  return isRecord(body) && isRecord(body.error) ? body.error.details : undefined;
}

/**
 * Field errors from a 400's `details` (`[{ path, message }]`): the first message per field of
 * `fields`; "toastTypes.1" counts for toastTypes. Unknown paths and malformed entries are ignored.
 */
export function fieldErrorsFrom<K extends string>(
  details: unknown,
  fields: readonly K[],
): Partial<Record<K, string>> {
  const errors: Partial<Record<K, string>> = {};
  if (!Array.isArray(details)) return errors;
  for (const d of details) {
    if (!isRecord(d)) continue;
    const { path, message } = d;
    if (typeof path !== 'string' || typeof message !== 'string') continue;
    const field = fields.find((f) => f === path.split('.')[0]);
    if (field !== undefined && errors[field] === undefined) errors[field] = message;
  }
  return errors;
}

/** How a failed request is told to the user. Only `fallback` is needed. */
export interface FailureOptions {
  /** The text when nothing better applies ("Couldn't revoke the key. Try again in a moment."). */
  fallback: string;
  /** The text for a 404 ("This key no longer exists. Reload the page."). */
  notFound?: string;
  /** The text for a 403 the hub gives no message for ("Only admins can do this."). */
  forbidden?: string;
  /** A 409 shows the hub's message, or this text when it gives none. */
  conflict?: string;
  /**
   * The statuses whose `error.message` is shown: 400, 403 and 503 when left out (the ones written
   * for the user), 'any' for every status.
   */
  hubMessageFor?: readonly number[] | 'any';
  /**
   * A 404 means the thing is gone for good (revoked or deleted elsewhere): refresh the page as well,
   * so it leaves the screen.
   */
  refreshOnNotFound?: boolean;
}

const HUB_MESSAGE_STATUSES: readonly number[] = [400, 403, 503];

/** What to tell the user when a request ended with `status` and `body` instead of succeeding. */
export function failureMessage(
  status: number,
  body: unknown,
  failure: FailureOptions | string,
): string {
  const options = typeof failure === 'string' ? { fallback: failure } : failure;
  if (status === NO_RESPONSE) return UNREACHABLE_MESSAGE;
  if (status === 401) return SESSION_ENDED_MESSAGE;
  if (status === 404 && options.notFound !== undefined) return options.notFound;
  if (status === 409 && options.conflict !== undefined) {
    return apiErrorMessage(body, options.conflict);
  }
  const shown = options.hubMessageFor ?? HUB_MESSAGE_STATUSES;
  if (shown !== 'any' && !shown.includes(status)) return options.fallback;
  return apiErrorMessage(
    body,
    (status === 403 ? options.forbidden : undefined) ?? options.fallback,
  );
}

/**
 * Whether the page is stale after this answer and must be refreshed: after a 401 the refresh sends
 * the signed-out user to /login (the layout's requireUser()), and after a 404 it drops what no
 * longer exists, for the requests that ask for it (`refreshOnNotFound`).
 */
export function refreshesPage(status: number, failure: FailureOptions | string): boolean {
  if (status === 401) return true;
  return status === 404 && typeof failure !== 'string' && failure.refreshOnNotFound === true;
}

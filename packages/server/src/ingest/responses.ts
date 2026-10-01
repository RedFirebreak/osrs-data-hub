/**
 * The status codes the plugin understands (handoff §3.2, §7.7, D-19): 401 only for auth, 410 only for
 * decommissioning, 429/503 + integer Retry-After for backpressure, 400/413 for input the plugin should
 * drop, 5xx only for faults a retry can fix. The body is ignored by the plugin but kept small and
 * consistent for humans and logs.
 */
import { TRANSIENT_RETRY_AFTER_SECONDS, type PluginResponse } from '../plugin/protocol';

export const ok = (): PluginResponse => ({ status: 200, body: { ok: true } });

const fail = (status: number, error: string, headers?: Record<string, string>): PluginResponse =>
  headers
    ? { status, body: { ok: false, error }, headers }
    : { status, body: { ok: false, error } };

export const gone = (): PluginResponse => fail(410, 'This hub no longer accepts data.');

export const unauthorized = (): PluginResponse => fail(401, 'unauthorized');

export const pluginOutdated = (): PluginResponse => fail(400, 'plugin_outdated');

export const payloadTooLarge = (): PluginResponse => fail(413, 'payload_too_large');

export const invalidJson = (): PluginResponse => fail(400, 'invalid_json');

export const invalidPayload = (): PluginResponse => fail(400, 'invalid_payload');

export const unknownAccount = (): PluginResponse => fail(400, 'unknown_account');

/** `retryAfterSeconds` must be a whole number: the plugin ignores "3.5" (PLUGIN-5). */
export const rateLimited = (retryAfterSeconds: number): PluginResponse =>
  fail(429, 'rate_limited', { 'Retry-After': String(retryAfterSeconds) });

export const temporarilyUnavailable = (): PluginResponse =>
  fail(503, 'temporarily_unavailable', {
    'Retry-After': String(TRANSIENT_RETRY_AFTER_SECONDS),
  });

export const internalError = (): PluginResponse => fail(500, 'internal_error');

/** The `error` string of a response body, if it has one. */
export function responseError(res: PluginResponse): string | undefined {
  const error = res.body.error;
  return typeof error === 'string' ? error : undefined;
}

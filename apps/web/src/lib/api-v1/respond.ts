/**
 * Responses and parameter parsing shared by the /api/v1 route handlers (D-71): the `{ data, meta }`
 * envelope, the one 404 for an account, and the zod parsing of query and path parameters (a ZodError
 * is answered 400 `invalid_request` with field details by handleApi).
 */
import type { z } from 'zod';
import { ApiError, json } from '@/lib/http';
import { AccountPath } from './schemas';

/**
 * 200 `{ data, meta }`, `meta` = `{ generated_at, …meta }`. `Cache-Control: no-store` unless
 * `headers` sets its own (json()).
 */
export function v1Ok(data: unknown, meta: Record<string, unknown> = {}, headers?: HeadersInit) {
  return json(200, { data, meta: { generated_at: new Date().toISOString(), ...meta } }, headers);
}

/** An error response `{ error: { code, message } }` (outside handleApi's mapping). */
export function v1Error(
  status: number,
  code: string,
  message: string,
  headers?: Record<string, string>,
): Response {
  return json(status, { error: { code, message } }, headers);
}

/**
 * The one 404 of the per-account endpoints: an unknown id, an id that can't be one, an account
 * outside the key's scope and one whose category the key can't read all look exactly alike (D-70).
 */
export const ACCOUNT_NOT_FOUND_MESSAGE = 'Account not found.';

export function accountNotFound(): ApiError {
  return new ApiError(404, 'not_found', ACCOUNT_NOT_FOUND_MESSAGE);
}

/**
 * The query string parsed with `schema` (a repeated parameter keeps its last value; unknown ones are
 * ignored). Only the search part of request.url is read: its host is the bind address (NEXT-2).
 */
export function parseQuery<S extends z.ZodType>(request: Request, schema: S): z.output<S> {
  return schema.parse(Object.fromEntries(new URL(request.url).searchParams)) as z.output<S>;
}

/**
 * The `{id}` path parameter; one that can't be an account id is answered 404 (accountNotFound)
 * without a query: Next decodes `%00` in the path, and Postgres refuses NUL in text (DB-1).
 */
export async function accountIdFrom(params: Promise<{ id: string }>): Promise<string> {
  const parsed = AccountPath.safeParse(await params);
  if (!parsed.success) throw accountNotFound();
  return parsed.data.id;
}

/** 200 with `map(value)` as `data`, or the account 404 when the read model answered null. */
export function found<T, W>(value: T | null, map: (value: T) => W): Response {
  if (value === null) throw accountNotFound();
  return v1Ok(map(value));
}

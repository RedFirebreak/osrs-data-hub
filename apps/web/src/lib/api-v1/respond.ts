/**
 * Responses and path parsing shared by the /api/v1 route handlers (D-71): the `{ data, meta }`
 * envelope and the `{id}` path parameter, with the one 404 for an account (lib/http.ts). Query
 * strings are parsed with parseQuery (lib/query.ts) and the schemas in schemas.ts.
 */
import { accountNotFound, json } from '@/lib/http';
import { AccountPath, type WireMetaExtra } from './schemas';

/**
 * 200 `{ data, meta }`, `meta` = `{ generated_at, …meta }`. `Cache-Control: no-store` unless
 * `headers` sets its own (json()).
 */
export function v1Ok(data: unknown, meta: WireMetaExtra = {}, headers?: HeadersInit) {
  return json(200, { data, meta: { generated_at: new Date().toISOString(), ...meta } }, headers);
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

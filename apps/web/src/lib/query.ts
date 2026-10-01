/**
 * Query-string parsing shared by the UI's routes (/api/app, /api/live) and the public API
 * (/api/v1): one definition of how a query string becomes an object, of an ISO instant, of an
 * account id and of a cursor number. What differs per route (defaults, caps, which errors are field
 * errors) stays in the route's own schema.
 */
import { PUBLIC_ID_PATTERN } from '@hub/server';
import { z } from 'zod';

/**
 * The query parameters as an object (a repeated parameter keeps its last value). Only the search
 * part of the URL is read: request.url's host is the bind address (NEXT-2).
 */
export function queryOf(url: string | URL): Record<string, string> {
  return Object.fromEntries(new URL(url).searchParams);
}

/**
 * The request's query string parsed with `schema` (unknown parameters are ignored by a z.object).
 * A malformed value throws a ZodError, which handleApi answers 400 `invalid_request` with field
 * details.
 */
export function parseQuery<S extends z.ZodType>(request: Request, schema: S): z.output<S> {
  return schema.parse(queryOf(request.url)) as z.output<S>;
}

/** ISO-8601 date-time with `Z` or an offset ("2026-09-29T10:00:00Z"); a date alone is refused. */
export const isoInstant = z.iso
  .datetime({ offset: true, error: 'must be an ISO-8601 date-time with Z or an offset' })
  .transform((s) => new Date(s));

/** An account's public id in a path, query or list parameter (the server's pattern, D-46). */
export const accountId = z.string().regex(PUBLIC_ID_PATTERN, 'not an account id');

/**
 * An event cursor (a seq) as a client sends it back: a non-negative safe integer in plain digits,
 * 0 included; anything else (absent, garbage) is null, "no cursor".
 */
export function parseSeq(raw: string | null | undefined): number | null {
  const value = raw?.trim() ?? '';
  if (!/^\d{1,16}$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

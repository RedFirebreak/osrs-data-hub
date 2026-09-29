/**
 * Parameter checks shared by the public API read models. The web layer parses query strings with
 * zod first; these checks keep the read models safe on their own (they are exported and callable
 * directly) and throw ApiError('invalid') with a message that names the parameter.
 */
import { ApiError } from './errors';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * What a public id can look like (D-46: 12 base62 characters; longer ones exist in tests). Anything
 * else can't be one and is never sent to the database: Postgres refuses NUL in text (DB-1).
 */
const PUBLIC_ID_RE = /^[0-9A-Za-z]{1,64}$/;

/** Most ids or names one list parameter (`ids`, `names`, `accounts`) may carry. */
export const MAX_LIST_PARAM = 100;

/** True when `value` has the shape of a public id (so it may be looked up). */
export function isPublicIdLike(value: unknown): value is string {
  return typeof value === 'string' && PUBLIC_ID_RE.test(value);
}

/** Throws ApiError('invalid') unless `value` is a valid Date. */
export function assertDate(value: unknown, name: string): asserts value is Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new ApiError('invalid', `${name} must be a valid ISO-8601 date`);
  }
}

export interface ResolvedRange {
  from: Date;
  to: Date;
}

/**
 * A from/to range with defaults: `to` = now, `from` = to − `defaultDays`. Refuses invalid dates and a
 * `from` after `to`.
 */
export function resolveRange(
  params: { from?: Date; to?: Date },
  now: Date,
  defaultDays: number,
): ResolvedRange {
  if (params.to !== undefined) assertDate(params.to, 'to');
  if (params.from !== undefined) assertDate(params.from, 'from');
  const to = params.to ?? now;
  const from = params.from ?? new Date(to.getTime() - defaultDays * DAY_MS);
  if (from.getTime() > to.getTime()) throw new ApiError('invalid', 'from must not be after to');
  return { from, to };
}

/**
 * A list parameter: strings only, duplicates dropped (first occurrence kept), at most `max` entries
 * (else ApiError invalid). Undefined stays undefined ("no filter"); an empty list is kept as given.
 */
export function listParam(
  values: readonly unknown[] | undefined,
  name: string,
  max: number = MAX_LIST_PARAM,
): string[] | undefined {
  if (values === undefined) return undefined;
  if (!Array.isArray(values) || values.some((v) => typeof v !== 'string')) {
    throw new ApiError('invalid', `${name} must be a list of strings`);
  }
  const unique = [...new Set(values as string[])];
  if (unique.length > max) {
    throw new ApiError('invalid', `${name} may list at most ${max} values`);
  }
  return unique;
}

/** A whole number in [min, max], or `fallback` when undefined; anything else is ApiError invalid. */
export function intParam(
  value: number | undefined,
  name: string,
  opts: { min: number; max: number; fallback: number },
): number {
  if (value === undefined) return opts.fallback;
  if (!Number.isSafeInteger(value) || value < opts.min || value > opts.max) {
    throw new ApiError('invalid', `${name} must be a whole number from ${opts.min} to ${opts.max}`);
  }
  return value;
}

/** `value` when it is one of `allowed` (or `fallback` when undefined), else ApiError invalid. */
export function enumParam<T extends string>(
  value: unknown,
  name: string,
  allowed: readonly T[],
  fallback: T,
): T {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new ApiError('invalid', `${name} must be one of ${allowed.join(', ')}`);
  }
  return value as T;
}

/**
 * Query-string parsing for the account read routes (/api/app/accounts/[publicId]/* and
 * /api/app/feed). Strict for our own API (D-10): a malformed value is a 400 `invalid_request` with
 * field errors (a ZodError, mapped by handleApi), never silently replaced by a default. Parameters
 * the routes don't know are ignored, as query strings usually are. The primitives (an ISO instant,
 * an account id, the range rule) are the public API's (lib/query.ts, @hub/server resolveRange); the
 * defaults here are the UI's own.
 */
import {
  FEED_MAX_LIMIT,
  MAX_SERIES_SKILLS,
  ApiError as ServerApiError,
  XP_RESOLUTIONS,
  resolveRange,
  type HistoryRange,
  type Resolution,
} from '@hub/server';
import { z } from 'zod';
import { accountId, isoInstant, queryOf } from '@/lib/query';

/** The window a history route covers when the request leaves `from` out: the 30 days before `to`. */
export const DEFAULT_HISTORY_DAYS = 30;

const rangeShape = {
  from: isoInstant.optional(),
  to: isoInstant.optional(),
};

/**
 * Completes an optional from/to pair by the API's rule (resolveRange): `to` defaults to now, `from`
 * to `defaultDays` before `to`, and `from` may not be after `to`. Its refusal becomes a field error
 * on `from`, like every other malformed value here.
 */
function completeRange(
  v: { from?: Date | undefined; to?: Date | undefined },
  now: Date,
  defaultDays: number,
  ctx: z.RefinementCtx,
): HistoryRange {
  try {
    return resolveRange(v, now, defaultDays);
  } catch (err) {
    if (!(err instanceof ServerApiError)) throw err;
    ctx.addIssue({ code: 'custom', path: ['from'], message: err.message });
    return z.NEVER;
  }
}

/**
 * `?from=ISO&to=ISO` of the history route (locations). Both optional: `to` defaults to `now`, `from`
 * to DEFAULT_HISTORY_DAYS before `to`. Throws a ZodError (→ 400) for a value that isn't an ISO
 * instant, or `from` after `to`.
 */
export function parseHistoryRange(
  url: string | URL,
  now: Date,
  defaultDays = DEFAULT_HISTORY_DAYS,
): HistoryRange {
  return z
    .object(rangeShape)
    .transform((v, ctx) => completeRange(v, now, defaultDays, ctx))
    .parse(queryOf(url));
}

/** A skill name as the plugin sends it ("Attack", "Overall"); unknown names are left out later. */
const skillName = z
  .string()
  .trim()
  .min(1, 'empty skill name')
  .max(64)
  .regex(/^[A-Za-z][A-Za-z ]*$/, 'not a skill name');

export interface XpQuery extends HistoryRange {
  skills: string[];
  resolution: Resolution | 'auto';
}

/**
 * `?skills=Attack,Overall&from=ISO&to=ISO&resolution=auto|5m|1h|1d` of the XP series route.
 * skills defaults to "Overall" (at most MAX_SERIES_SKILLS, duplicates dropped); the range defaults
 * like parseHistoryRange; resolution defaults to 'auto'. Throws a ZodError (→ 400) otherwise.
 */
export function parseXpQuery(url: string | URL, now: Date): XpQuery {
  return z
    .object({
      skills: z
        .string()
        .optional()
        .transform((s) => (s === undefined ? ['Overall'] : s.split(',')))
        .pipe(
          z
            .array(skillName)
            .min(1)
            .max(MAX_SERIES_SKILLS, `at most ${MAX_SERIES_SKILLS} skills`)
            .transform((names) => [...new Set(names)]),
        ),
      resolution: z.enum(XP_RESOLUTIONS).default('auto'),
      ...rangeShape,
    })
    .transform(({ skills, resolution, from, to }, ctx) => ({
      skills,
      resolution,
      ...completeRange({ from, to }, now, DEFAULT_HISTORY_DAYS, ctx),
    }))
    .parse(queryOf(url));
}

/** Stored event types: lower_snake for known ones, unknown plugin types as sent (camelCase). */
const eventType = z
  .string()
  .trim()
  .regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/, 'not an event type');

export interface FeedQuery {
  accountPublicId?: string;
  types?: string[];
  beforeSeq?: number;
  limit?: number;
}

/**
 * `?account=<publicId>&types=loot,level_up&before=<seq>&limit=<1…200>` of the feed route; every
 * parameter optional (an empty `types` means all types). Throws a ZodError (→ 400) for a malformed
 * value; an account id that matches nothing is not an error (the feed is just empty).
 */
export function parseFeedQuery(url: string | URL): FeedQuery {
  const q = z
    .object({
      account: accountId.optional(),
      types: z
        .string()
        .optional()
        .transform((s) => (s === undefined || s.trim() === '' ? undefined : s.split(',')))
        .pipe(z.array(eventType).max(64).optional()),
      before: z
        .string()
        .regex(/^[1-9]\d{0,15}$/, 'must be a positive integer')
        .transform(Number)
        .pipe(z.number().int().max(Number.MAX_SAFE_INTEGER))
        .optional(),
      limit: z
        .string()
        .regex(/^\d{1,4}$/, 'must be an integer')
        .transform(Number)
        .pipe(z.number().int().min(1).max(FEED_MAX_LIMIT))
        .optional(),
    })
    .parse(queryOf(url));
  const out: FeedQuery = {};
  if (q.account !== undefined) out.accountPublicId = q.account;
  if (q.types !== undefined) out.types = [...new Set(q.types)];
  if (q.before !== undefined) out.beforeSeq = q.before;
  if (q.limit !== undefined) out.limit = q.limit;
  return out;
}

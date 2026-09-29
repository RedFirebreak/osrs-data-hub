/**
 * Query-string parsing for the account read routes (/api/app/accounts/[publicId]/* and
 * /api/app/feed). Strict for our own API (D-10): a malformed value is a 400 `invalid_request` with
 * field errors (a ZodError, mapped by handleApi), never silently replaced by a default. Parameters
 * the routes don't know are ignored, as query strings usually are.
 */
import { FEED_MAX_LIMIT, MAX_SERIES_SKILLS, type HistoryRange, type Resolution } from '@hub/server';
import { z } from 'zod';

const DAY_MS = 24 * 60 * 60 * 1000;

/** The window a history route covers when the request leaves `from` out: the 30 days before `to`. */
export const DEFAULT_HISTORY_DAYS = 30;

/** ISO-8601 with an offset or Z ("2026-09-29T10:00:00Z", "…+02:00"); a date alone is refused. */
const isoInstant = z.iso.datetime({ offset: true }).transform((s) => new Date(s));

const rangeShape = {
  from: isoInstant.optional(),
  to: isoInstant.optional(),
};

/** Completes an optional from/to pair: to defaults to now, from to `defaultDays` before `to`. */
function completeRange(
  v: { from?: Date | undefined; to?: Date | undefined },
  now: Date,
  defaultDays: number,
): HistoryRange {
  const to = v.to ?? now;
  const from = v.from ?? new Date(to.getTime() - defaultDays * DAY_MS);
  return { from, to };
}

const fromNotAfterTo = {
  message: '`from` must not be after `to`',
  path: ['from'],
};

/** The query parameters as an object (a repeated key keeps its last value). */
function paramsOf(url: string | URL): Record<string, string> {
  return Object.fromEntries(new URL(url).searchParams);
}

/**
 * `?from=ISO&to=ISO` of a history route (sessions, equipment, wealth, locations). Both optional:
 * `to` defaults to `now`, `from` to DEFAULT_HISTORY_DAYS before `to`. Throws a ZodError (→ 400) for
 * a value that isn't an ISO instant, or `from` after `to`.
 */
export function parseHistoryRange(
  url: string | URL,
  now: Date,
  defaultDays = DEFAULT_HISTORY_DAYS,
): HistoryRange {
  const p = paramsOf(url);
  return z
    .object(rangeShape)
    .transform((v) => completeRange(v, now, defaultDays))
    .refine((r) => r.from.getTime() <= r.to.getTime(), fromNotAfterTo)
    .parse({ from: p.from, to: p.to });
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
  const p = paramsOf(url);
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
      resolution: z.enum(['auto', '5m', '1h', '1d']).default('auto'),
      ...rangeShape,
    })
    .transform(({ skills, resolution, from, to }) => ({
      skills,
      resolution,
      ...completeRange({ from, to }, now, DEFAULT_HISTORY_DAYS),
    }))
    .refine((q) => q.from.getTime() <= q.to.getTime(), fromNotAfterTo)
    .parse({ skills: p.skills, resolution: p.resolution, from: p.from, to: p.to });
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
  const p = paramsOf(url);
  const q = z
    .object({
      account: z
        .string()
        .regex(/^[A-Za-z0-9]{1,64}$/, 'not an account id')
        .optional(),
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
    .parse({ account: p.account, types: p.types, before: p.before, limit: p.limit });
  const out: FeedQuery = {};
  if (q.account !== undefined) out.accountPublicId = q.account;
  if (q.types !== undefined) out.types = [...new Set(q.types)];
  if (q.before !== undefined) out.beforeSeq = q.before;
  if (q.limit !== undefined) out.limit = q.limit;
  return out;
}

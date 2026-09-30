/**
 * XP series and gains of the public API (handoff §13, §9 XP semantics): GET /accounts/{id}/xp,
 * GET /xp?accounts=…, GET /accounts/{id}/gains. The series come from the account page's read model
 * (getXpSeries, with the key's restriction), so the tiers, resolutions and the carried-in first point
 * are the same as in the UI. Every endpoint needs the `stats` category.
 */
import { OVERALL, sortSkillsForDisplay } from '@hub/core';
import type { DbOrTx } from '@hub/db';
import { periodStarts } from '../accounts/periods';
import {
  MAX_SERIES_SKILLS,
  getGains,
  getXpSeries,
  type Resolution,
  type XpSeries,
} from '../accounts/xp';
import { getUserSettings } from '../settings/user-settings';
import {
  MAX_BULK_ACCOUNTS,
  MAX_BULK_ACCOUNTS_SERVICE,
  accountRef,
  apiRestriction,
  apiViewer,
  bulkAccountLimit,
  loadApiAccount,
  requireApiAccounts,
} from './access';
import { ApiError } from './errors';
import type { ApiPrincipal } from './keys';
import { assertDate, enumParam, listParam, resolveRange } from './params';
import { canonicalSkills } from './skills';
import type { ApiAccountRef } from './types';

export const XP_RESOLUTIONS = ['auto', '5m', '1h', '1d'] as const;
export type ApiXpResolution = (typeof XP_RESOLUTIONS)[number];
/** The range of an XP request without `from`: the last 7 days (the raw 5-minute tier). */
export const XP_DEFAULT_DAYS = 7;
/** Most accounts one GET /xp may name with a user key (D-92). */
export const MAX_XP_ACCOUNTS = MAX_BULK_ACCOUNTS;
/** ... and with a service key (D-92). */
export const MAX_XP_ACCOUNTS_SERVICE = MAX_BULK_ACCOUNTS_SERVICE;
/** Most skills one XP request may name. */
export const MAX_XP_SKILLS = MAX_SERIES_SKILLS;

export interface ApiXpParams {
  /** Skill names, case-insensitive ("attack", "Overall"); default ["Overall"]. Unknown → invalid. */
  skills?: string[];
  /** Default: `to` − 7 days. */
  from?: Date;
  /** Default: now. */
  to?: Date;
  /** Default 'auto': 5m up to 7 days, 1h up to 90 days, 1d beyond (handoff §9). */
  resolution?: ApiXpResolution;
}

export interface ApiXpSeries {
  account: ApiAccountRef;
  /**
   * The resolution used: the requested one, or a coarser one when the range would have more than
   * 5000 points at it or starts before the raw 5-minute tier's retention.
   */
  resolution: Resolution;
  from: string;
  to: string;
  /**
   * One entry per requested skill in request order. Points are [bucket start (ISO), XP at the end of
   * that bucket], ascending; XP only changes where a point is (change-only tiers), and the value in
   * effect at `from` is carried in as a first point at the range start.
   */
  series: { skill: string; points: [string, number][] }[];
}

export interface ApiXpMulti {
  resolution: Resolution;
  from: string;
  to: string;
  /** In request order. */
  accounts: ApiXpSeries[];
}

interface XpRequest {
  skills: string[];
  from: Date;
  to: Date;
  resolution: ApiXpResolution;
}

async function xpRequest(db: DbOrTx, params: ApiXpParams, now: Date): Promise<XpRequest> {
  const { from, to } = resolveRange(params, now, XP_DEFAULT_DAYS);
  const resolution = enumParam(params.resolution, 'resolution', XP_RESOLUTIONS, 'auto');
  const requested = listParam(params.skills, 'skills', MAX_XP_SKILLS) ?? [];
  const skills = await canonicalSkills(db, requested.length > 0 ? requested : [OVERALL]);
  return { skills, from, to, resolution };
}

function toApiSeries(
  account: ApiAccountRef,
  series: XpSeries,
  req: Pick<XpRequest, 'from' | 'to'>,
): ApiXpSeries {
  return {
    account,
    resolution: series.resolution,
    from: req.from.toISOString(),
    to: req.to.toISOString(),
    series: series.series,
  };
}

/**
 * XP series of one account, or null when the key can't read the account's `stats` (the web answers
 * 404). ApiError 'invalid' for a bad range, resolution or skill.
 */
export async function apiXp(
  db: DbOrTx,
  principal: ApiPrincipal,
  id: string,
  params: ApiXpParams = {},
  now: Date = new Date(),
): Promise<ApiXpSeries | null> {
  const req = await xpRequest(db, params, now);
  const entry = await loadApiAccount(db, principal, id, 'stats');
  if (!entry) return null;
  const series = await getXpSeries(db, apiViewer(principal), id, req, apiRestriction(principal));
  return series === null ? null : toApiSeries(accountRef(entry), series, req);
}

/**
 * XP series of several accounts (GET /xp?accounts=a,b): at most MAX_XP_ACCOUNTS (a service key:
 * MAX_XP_ACCOUNTS_SERVICE, D-92), each of which the key must be able to read `stats` of, else
 * ApiError 'not_found' naming it (D-70). One series request per account, in request order.
 */
export async function apiXpMulti(
  db: DbOrTx,
  principal: ApiPrincipal,
  params: ApiXpParams & { ids: string[] },
  now: Date = new Date(),
): Promise<ApiXpMulti> {
  const req = await xpRequest(db, params, now);
  const entries = await requireApiAccounts(
    db,
    principal,
    params.ids,
    'stats',
    'accounts',
    bulkAccountLimit(principal),
  );
  const accounts: ApiXpSeries[] = [];
  for (const entry of entries) {
    const series = await getXpSeries(
      db,
      apiViewer(principal),
      entry.account.publicId,
      req,
      apiRestriction(principal),
    );
    if (series === null)
      throw new ApiError('not_found', `account ${entry.account.publicId} not found`);
    accounts.push(toApiSeries(accountRef(entry), series, req));
  }
  const resolution = accounts[0]?.resolution ?? pickFallback(req.resolution);
  return { resolution, from: req.from.toISOString(), to: req.to.toISOString(), accounts };
}

/** The creator's time zone (their settings); undefined (UTC) for a service key (D-88). */
export async function principalTimezone(
  db: DbOrTx,
  principal: ApiPrincipal,
): Promise<string | undefined> {
  return principal.userId === null
    ? undefined
    : (await getUserSettings(db, principal.userId)).timezone;
}

function pickFallback(resolution: ApiXpResolution): Resolution {
  return resolution === 'auto' ? '5m' : resolution;
}

export const GAINS_PERIODS = ['day', 'week', 'month', 'year'] as const;
export type ApiGainsPeriod = (typeof GAINS_PERIODS)[number];

export interface ApiGainsParams {
  /**
   * day = since local midnight in the key creator's time zone (their settings; UTC for a service
   * key, which has no creator, D-88), week/month/year = the last 7/30/365 days. Default 'day' when
   * neither `period` nor `from` is given.
   */
  period?: ApiGainsPeriod;
  /** An explicit range instead of `period` (not both). */
  from?: Date;
  /** With `from`; default now. */
  to?: Date;
}

export interface ApiGains {
  account: ApiAccountRef;
  /** null for an explicit from/to range. */
  period: ApiGainsPeriod | null;
  from: string;
  to: string;
  /**
   * XP gained per skill, Overall first then the in-game grid order, every skill the account has
   * (0 when nothing was gained): xp_at(to) − xp_at(from), where a skill first seen inside the range
   * counts from its first sample (handoff §9).
   */
  gains: { skill: string; xp: number }[];
}

/**
 * Gains per skill of one account for a period or an explicit range, or null when the key can't read
 * the account's `stats`. ApiError 'invalid' for `period` together with `from`/`to`, `to` without
 * `from`, an unknown period, an invalid date, or `from` after `to`.
 */
export async function apiGains(
  db: DbOrTx,
  principal: ApiPrincipal,
  id: string,
  params: ApiGainsParams = {},
  now: Date = new Date(),
): Promise<ApiGains | null> {
  const explicit = params.from !== undefined || params.to !== undefined;
  if (params.period !== undefined && explicit) {
    throw new ApiError('invalid', 'give either period or from/to, not both');
  }
  if (params.to !== undefined && params.from === undefined) {
    throw new ApiError('invalid', 'to needs from');
  }
  const period = explicit ? null : enumParam(params.period, 'period', GAINS_PERIODS, 'day');
  if (params.from !== undefined) assertDate(params.from, 'from');
  if (params.to !== undefined) assertDate(params.to, 'to');

  const entry = await loadApiAccount(db, principal, id, 'stats');
  if (!entry) return null;
  let from: Date;
  let to: Date | undefined;
  if (period === null) {
    ({ from, to } = resolveRange(params, now, 0));
    if (params.to === undefined) to = undefined; // now = the current XP (latest_state)
  } else {
    const timezone = period === 'day' ? await principalTimezone(db, principal) : undefined;
    const starts = periodStarts(now, timezone);
    from = { day: starts.today, week: starts.week, month: starts.month, year: starts.year }[period];
  }
  const gains = await getGains(db, entry.account.id, to === undefined ? { from } : { from, to });
  return {
    account: accountRef(entry),
    period,
    from: from.toISOString(),
    to: (to ?? now).toISOString(),
    gains: sortSkillsForDisplay([...gains.keys()]).map((skill) => ({
      skill,
      xp: gains.get(skill) ?? 0,
    })),
  };
}

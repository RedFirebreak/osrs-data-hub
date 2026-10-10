/**
 * The Progress pages' view as it lives in their address: a range and what is counted. Small on
 * purpose (the full set of filters belongs to Deep dive, D-106), and lenient like it: anything that
 * doesn't parse is its default. Pure and client-safe.
 *
 *   /progress/<id>?range=30d&measure=gp
 *   /progress/<id>/skills/firemaking?range=all
 */
import {
  DAY_MS,
  DEFAULT_METRICS_QUERY,
  isMetricsMeasure,
  type MetricsMeasure,
  type MetricsQuery,
} from '@hub/core';

/** The ranges every Progress page offers, shortest first; 'all' only where XP is the measure. */
export const PROGRESS_RANGES = ['1d', '7d', '30d', '90d', '1y'] as const;
export type ProgressRange = (typeof PROGRESS_RANGES)[number] | 'all';

export const DEFAULT_PROGRESS_RANGE: ProgressRange = '7d';

/** On the control. */
export const PROGRESS_RANGE_LABELS: Readonly<Record<ProgressRange, string>> = {
  '1d': '1D',
  '7d': '7D',
  '30d': '30D',
  '90d': '90D',
  '1y': '1Y',
  all: 'All',
};

/** After an amount: "+12,345 XP in the last 7 days". */
export const PROGRESS_RANGE_WORDS: Readonly<Record<ProgressRange, string>> = {
  '1d': 'in the last 24 hours',
  '7d': 'in the last 7 days',
  '30d': 'in the last 30 days',
  '90d': 'in the last 90 days',
  '1y': 'in the last year',
  all: 'since the hub first saw this character',
};

export const PROGRESS_MEASURES: readonly MetricsMeasure[] = ['xp', 'gp', 'kills', 'active'];

/** On the pills. */
export const PROGRESS_MEASURE_LABELS: Readonly<Record<MetricsMeasure, string>> = {
  xp: 'XP',
  gp: 'Loot',
  kills: 'Boss kills',
  active: 'Play time',
};

export interface ProgressQuery {
  range: ProgressRange;
  measure: MetricsMeasure;
}

export const DEFAULT_PROGRESS_QUERY: ProgressQuery = {
  range: DEFAULT_PROGRESS_RANGE,
  measure: 'xp',
};

type Params = URLSearchParams | Readonly<Record<string, string | string[] | undefined>>;

function first(params: Params, key: string): string | null {
  if (params instanceof URLSearchParams) return params.get(key);
  const value = params[key];
  return (Array.isArray(value) ? value[0] : value) ?? null;
}

/**
 * The view from a page's search parameters. `all` says whether the page offers the 'all' range (a
 * skill page: the hub keeps daily XP forever); elsewhere it falls back to the default.
 */
export function parseProgressQuery(params: Params, opts: { all?: boolean } = {}): ProgressQuery {
  const range = first(params, 'range');
  const measure = first(params, 'measure');
  const known =
    (PROGRESS_RANGES as readonly string[]).includes(range ?? '') || (opts.all && range === 'all');
  return {
    range: known ? (range as ProgressRange) : DEFAULT_PROGRESS_RANGE,
    measure: isMetricsMeasure(measure) ? measure : 'xp',
  };
}

/** The search string (without "?"): only what differs from the defaults, so equal views share a URL. */
export function progressSearch(query: ProgressQuery): string {
  const q = new URLSearchParams();
  if (query.range !== DEFAULT_PROGRESS_RANGE) q.set('range', query.range);
  if (query.measure !== 'xp') q.set('measure', query.measure);
  return q.toString();
}

const ROLLING_DAYS: Readonly<Record<Exclude<ProgressRange, '1d' | 'all'>, MetricsQuery['range']>> =
  {
    '7d': '7d',
    '30d': '30d',
    '90d': '90d',
    '1y': '1y',
  };

/**
 * The Metrics query behind a Progress view (getAccountMetrics): the same rolling presets, with "1D"
 * as the 24 hours up to `now` rather than "since midnight" (a custom range of two instants), and
 * 'all' as the longest range Metrics reads (a year; the skill page draws all of the XP itself).
 * `skill` narrows the XP measure to one skill.
 */
export function progressMetricsQuery(
  query: ProgressQuery,
  now: Date,
  skill?: string,
): MetricsQuery {
  const base: MetricsQuery = {
    ...DEFAULT_METRICS_QUERY,
    measure: query.measure,
    skills: skill === undefined ? [] : [skill],
  };
  if (query.range === '1d') {
    return {
      ...base,
      range: 'custom',
      from: new Date(now.getTime() - DAY_MS).toISOString(),
      to: now.toISOString(),
    };
  }
  return { ...base, range: query.range === 'all' ? '1y' : ROLLING_DAYS[query.range] };
}

/** The Deep dive range closest to a Progress range, for the link between them. */
export function deepDiveRange(range: ProgressRange): MetricsQuery['range'] {
  if (range === '1d') return 'today';
  return range === 'all' ? '1y' : ROLLING_DAYS[range];
}

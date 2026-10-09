/**
 * Metrics' filters as they live in the page's URL (D-106), so a view can be bookmarked or sent to
 * someone who may see the account. Parsing is lenient: anything malformed falls back to its default
 * rather than failing the page. Pure and client-safe; the server resolves the range against the
 * clock and the viewer's time zone.
 */
import { isMetricsMeasure, type MetricsMeasure } from './sessions';

export const METRICS_RANGES = ['today', '7d', '30d', '90d', '1y', 'custom'] as const;
export type MetricsRange = (typeof METRICS_RANGES)[number];

export const METRICS_RANGE_LABELS: Readonly<Record<MetricsRange, string>> = {
  today: 'Today',
  '7d': '7 days',
  '30d': '30 days',
  '90d': '90 days',
  '1y': 'Year',
  custom: 'Custom',
};

export const DEFAULT_METRICS_RANGE: MetricsRange = '30d';
/** The longest custom range: XP is kept at 5 minutes for a year (XP_RAW_RETENTION_DAYS). */
export const MAX_METRICS_RANGE_DAYS = 366;
/** Most skills or bosses a filter names. */
export const MAX_METRICS_SELECTION = 30;

export interface MetricsQuery {
  range: MetricsRange;
  /**
   * For `custom`: the first and last day (YYYY-MM-DD, both included, in the viewer's time zone) or
   * two instants (ISO, from a brush on a time axis). Null otherwise.
   */
  from: string | null;
  to: string | null;
  /** A session to show the timeline of. */
  session: string | null;
  /** Overlay the previous period of the same length. */
  compare: boolean;
  measure: MetricsMeasure;
  /** Skills the XP measure counts; empty = all. */
  skills: string[];
  /** Bosses the kills measure counts; empty = all. */
  bosses: string[];
  /** Shortest session, in minutes. */
  minMinutes: number | null;
  /** Local weekdays sessions start on, 0 = Monday … 6 = Sunday; empty = any. */
  weekdays: number[];
  /** Local hours sessions start in, [from, to), wrapping past midnight; null = any. */
  hours: { from: number; to: number } | null;
  /** Sessions whose main activity is this. */
  activity: string | null;
}

export const DEFAULT_METRICS_QUERY: MetricsQuery = Object.freeze({
  range: DEFAULT_METRICS_RANGE,
  from: null,
  to: null,
  session: null,
  compare: false,
  measure: 'xp',
  skills: [],
  bosses: [],
  minMinutes: null,
  weekdays: [],
  hours: null,
  activity: null,
}) as MetricsQuery;

type Params = URLSearchParams | Readonly<Record<string, string | string[] | undefined>>;

function first(params: Params, key: string): string | null {
  if (params instanceof URLSearchParams) return params.get(key);
  const value = params[key];
  return (Array.isArray(value) ? value[0] : value) ?? null;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Text a name from the URL may hold: what Jagex and the plugin use in skill and boss names. */
const NAME_RE = /^[\p{L}\p{N} '’().:&+-]{1,64}$/u;

/** A custom bound: a calendar day or an instant; null when neither. */
export function parseRangeBound(value: string | null): string | null {
  if (value === null) return null;
  if (DAY_RE.test(value)) return Number.isFinite(Date.parse(`${value}T00:00:00Z`)) ? value : null;
  const t = Date.parse(value);
  return value.length <= 40 && Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function names(value: string | null): string[] {
  if (!value) return [];
  const out: string[] = [];
  for (const part of value.split(',')) {
    const name = part.trim();
    if (NAME_RE.test(name) && !out.includes(name)) out.push(name);
    if (out.length >= MAX_METRICS_SELECTION) break;
  }
  return out;
}

function int(value: string | null, min: number, max: number): number | null {
  if (value === null || !/^\d{1,5}$/.test(value)) return null;
  const n = Number(value);
  return n >= min && n <= max ? n : null;
}

/** The query from the page's search parameters; every part that doesn't parse is its default. */
export function parseMetricsQuery(params: Params): MetricsQuery {
  const rangeText = first(params, 'range');
  let range: MetricsRange = (METRICS_RANGES as readonly string[]).includes(rangeText ?? '')
    ? (rangeText as MetricsRange)
    : DEFAULT_METRICS_RANGE;
  let from: string | null = null;
  let to: string | null = null;
  if (range === 'custom') {
    from = parseRangeBound(first(params, 'from'));
    to = parseRangeBound(first(params, 'to'));
    if (from === null || to === null) {
      range = DEFAULT_METRICS_RANGE;
      from = null;
      to = null;
    }
  }
  const measure = first(params, 'measure');
  const session = first(params, 'session');
  const weekdays = (first(params, 'days') ?? '')
    .split(',')
    .map((d) => int(d, 0, 6))
    .filter((d): d is number => d !== null);
  const hoursMatch = /^(\d{1,2})-(\d{1,2})$/.exec(first(params, 'hours') ?? '');
  const hFrom = hoursMatch ? int(hoursMatch[1]!, 0, 23) : null;
  const hTo = hoursMatch ? int(hoursMatch[2]!, 0, 24) : null;
  const activity = first(params, 'activity');
  return {
    range,
    from,
    to,
    session: session && /^[0-9a-f-]{36}$/i.test(session) ? session.toLowerCase() : null,
    compare: first(params, 'compare') === '1',
    measure: isMetricsMeasure(measure) ? measure : 'xp',
    skills: names(first(params, 'skills')),
    bosses: names(first(params, 'bosses')),
    minMinutes: int(first(params, 'min'), 1, 24 * 60),
    weekdays: [...new Set(weekdays)].sort((a, b) => a - b),
    hours:
      hFrom !== null && hTo !== null && hFrom !== hTo % 24 ? { from: hFrom, to: hTo % 24 } : null,
    activity: activity && NAME_RE.test(activity) ? activity : null,
  };
}

/**
 * The search string (without "?") for a query: only what differs from the defaults, in a fixed
 * order, so equal views have equal URLs.
 */
export function metricsSearch(query: MetricsQuery): string {
  const q = new URLSearchParams();
  if (query.range !== DEFAULT_METRICS_RANGE) q.set('range', query.range);
  if (query.range === 'custom' && query.from && query.to) {
    q.set('from', query.from);
    q.set('to', query.to);
  }
  if (query.session) q.set('session', query.session);
  if (query.compare) q.set('compare', '1');
  if (query.measure !== 'xp') q.set('measure', query.measure);
  if (query.skills.length > 0) q.set('skills', query.skills.join(','));
  if (query.bosses.length > 0) q.set('bosses', query.bosses.join(','));
  if (query.minMinutes !== null) q.set('min', String(query.minMinutes));
  if (query.weekdays.length > 0) q.set('days', query.weekdays.join(','));
  if (query.hours) q.set('hours', `${query.hours.from}-${query.hours.to}`);
  if (query.activity) q.set('activity', query.activity);
  return q.toString();
}

/** Whether any session filter is set (they narrow the session charts, not the period totals). */
export function hasSessionFilter(query: MetricsQuery): boolean {
  return (
    query.minMinutes !== null ||
    query.weekdays.length > 0 ||
    query.hours !== null ||
    query.activity !== null
  );
}

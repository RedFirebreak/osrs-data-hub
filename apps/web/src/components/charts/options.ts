/**
 * ECharts options for the account page's charts (XP, playtime, wealth), built from plain data and a
 * resolved ChartTheme, and the shared parts every chart of the hub is assembled from (also used by
 * admin/ingest-chart.ts). Pure: no DOM and no echarts runtime (type-only imports), so the builders are
 * unit-tested in the node project and only charts/echart.tsx loads echarts itself.
 *
 * Marks follow the hub's chart rules: 2px lines, a ~10% area wash, bars at most 24px wide with 4px
 * rounded tops, hairline grid, one y-axis, text in text colours (never the series colour), a
 * crosshair tooltip on lines and an axis-shadow tooltip on bars, and a legend only for 2+ series.
 */
import { formatDuration, formatGp, formatNumber } from '@hub/core';
import type { BarSeriesOption, LineSeriesOption } from 'echarts/charts';
import type {
  GridComponentOption,
  LegendComponentOption,
  TooltipComponentOption,
} from 'echarts/components';
import type { ComposeOption } from 'echarts/core';
import { DATE_TIME_OPTIONS, formatInZone } from '@/lib/dates';

export type ChartOption = ComposeOption<
  | BarSeriesOption
  | LineSeriesOption
  | GridComponentOption
  | LegendComponentOption
  | TooltipComponentOption
>;

/** Colours and font a chart is drawn with, resolved from the page's CSS variables (echart.tsx). */
export interface ChartTheme {
  dark: boolean;
  /** Axis labels, legend text (muted ink). */
  mutedText: string;
  /** Values in tooltips (primary ink). */
  text: string;
  /** Gridlines and the axis line (hairline). */
  grid: string;
  tooltipBackground: string;
  tooltipBorder: string;
  fontFamily: string;
  /** Categorical series colours in fixed order (never cycled). */
  series: readonly [string, string, string];
}

/**
 * Series colours stepped per mode (blue, orange, then aqua), validated in that order against the card
 * surface in both modes (colour-blind separation of adjacent pairs; 3:1 contrast, except aqua on the
 * light card at 2.8:1, so a chart using the third colour needs its numbers in text too).
 */
export const SERIES_LIGHT = ['#2a78d6', '#eb6834', '#1baf7a'] as const;
export const SERIES_DARK = ['#3987e5', '#d95926', '#199e70'] as const;

/** Used until the page's colours are resolved (and on the server, where nothing is drawn). */
export const FALLBACK_THEME: ChartTheme = {
  dark: false,
  mutedText: '#737373',
  text: '#0a0a0a',
  grid: '#e5e5e5',
  tooltipBackground: '#ffffff',
  tooltipBorder: '#e5e5e5',
  fontFamily: 'system-ui, sans-serif',
  series: SERIES_LIGHT,
};

// --- Shared parts --------------------------------------------------------------------------------
// What every chart is assembled from, so a new chart is its data plus a tooltip formatter:
//
//   return {
//     ...baseOption(theme),
//     tooltip: axisTooltip(theme, 'line', (params) => {
//       const entry = rows[firstParam(params)?.dataIndex ?? -1];
//       return entry ? tooltipTitle(entry.day) + tooltipRow(color, entry.text, 'label') : '';
//     }),
//     xAxis: categoryAxis(theme, rows.map((r) => r.day)),
//     yAxis: valueAxis(theme, { scale: true }),
//     series: [lineSeries(theme, { name, color, data, showSymbol: false })],
//   };

type XAxisOption = Exclude<NonNullable<ChartOption['xAxis']>, readonly unknown[]>;
type YAxisOption = Exclude<NonNullable<ChartOption['yAxis']>, readonly unknown[]>;

/**
 * What every chart starts from: no animation, the page's font and the plot area. `legend: true`
 * leaves room above the plot for the legend row (see `legend`).
 */
export function baseOption(
  theme: ChartTheme,
  { legend = false }: { legend?: boolean } = {},
): Pick<ChartOption, 'animation' | 'textStyle' | 'grid'> {
  return {
    animation: false,
    textStyle: { fontFamily: theme.fontFamily },
    grid: {
      left: 4,
      right: 12,
      top: legend ? 36 : 12,
      bottom: 4,
      outerBoundsMode: 'same',
      outerBoundsContain: 'axisLabel',
    },
  };
}

/**
 * The legend row above the plot, for a chart with 2+ series (with `baseOption(theme, { legend: true })`).
 * `key` is the size of the colour key: a short line for line series, a square for bars.
 */
export function legend(
  theme: ChartTheme,
  names: readonly string[],
  key: { width: number; height: number },
): LegendComponentOption {
  return {
    top: 0,
    left: 0,
    icon: 'roundRect',
    itemWidth: key.width,
    itemHeight: key.height,
    textStyle: { color: theme.mutedText, fontFamily: theme.fontFamily, fontSize: 12 },
    data: [...names],
  };
}

/**
 * The tooltip of one x position: a crosshair ('line', for line charts) or a shaded column ('shadow',
 * for bars) with the chart's own HTML from `formatter`. Build that with tooltipTitle and tooltipRow,
 * which escape their text.
 */
export function axisTooltip(
  theme: ChartTheme,
  pointer: 'line' | 'shadow',
  formatter: (params: unknown) => string,
): TooltipComponentOption {
  return {
    confine: true,
    backgroundColor: theme.tooltipBackground,
    borderColor: theme.tooltipBorder,
    borderWidth: 1,
    padding: [6, 10],
    textStyle: { color: theme.text, fontFamily: theme.fontFamily, fontSize: 12 },
    extraCssText: 'border-radius: 8px; box-shadow: 0 4px 12px rgb(0 0 0 / 0.12);',
    trigger: 'axis',
    axisPointer:
      pointer === 'line'
        ? { type: 'line', lineStyle: { color: theme.mutedText, width: 1 } }
        : { type: 'shadow', shadowStyle: { opacity: 0.08 } },
    formatter,
  };
}

function axisLabel(theme: ChartTheme) {
  return { color: theme.mutedText, fontFamily: theme.fontFamily, fontSize: 11 };
}

/** The line, ticks and labels every x-axis shares (labels that would overlap are left out). */
function xAxisBase(theme: ChartTheme) {
  return {
    axisLine: { lineStyle: { color: theme.grid } },
    axisTick: { show: false },
    axisLabel: { ...axisLabel(theme), hideOverlap: true },
  };
}

/**
 * An x-axis of labelled positions (days, minutes), one per data point. `boundaryGap: false` puts the
 * first and last point on the plot's edges (lines); the default leaves half a step (bars).
 */
export function categoryAxis(
  theme: ChartTheme,
  labels: readonly string[],
  { boundaryGap = true }: { boundaryGap?: boolean } = {},
): XAxisOption {
  return {
    type: 'category',
    ...(boundaryGap ? {} : { boundaryGap: false }),
    data: [...labels],
    ...xAxisBase(theme),
  };
}

/** An x-axis of time spanning exactly `from` … `to`, whatever part of it the data covers. */
export function timeAxis(theme: ChartTheme, from: Date, to: Date): XAxisOption {
  return {
    type: 'time',
    min: from.getTime(),
    max: to.getTime(),
    ...xAxisBase(theme),
    splitLine: { show: false },
  };
}

/**
 * The one y-axis: hairline gridlines and muted labels. `scale` fits the axis to the data instead of
 * starting at zero (XP and wealth are far from it); `minInterval: 1` keeps the ticks whole numbers
 * (counts, hours); `format` writes the labels.
 */
export function valueAxis(
  theme: ChartTheme,
  opts: { scale?: boolean; minInterval?: number; format?: (value: number) => string } = {},
): YAxisOption {
  return {
    type: 'value',
    ...(opts.scale ? { scale: true } : {}),
    ...(opts.minInterval === undefined ? {} : { minInterval: opts.minInterval }),
    axisLabel: opts.format ? { ...axisLabel(theme), formatter: opts.format } : axisLabel(theme),
    splitLine: { lineStyle: { color: theme.grid, width: 1 } },
  };
}

/**
 * A line series by the chart rules: a 2px line with round joins, dots (where shown) ringed in the
 * surface colour, no hover emphasis. `extra` adds what one chart needs on top (a step, an area wash,
 * bridged gaps).
 */
export function lineSeries(
  theme: ChartTheme,
  series: { name: string; color: string; data: LineSeriesOption['data']; showSymbol: boolean },
  extra: LineSeriesOption = {},
): LineSeriesOption {
  const { name, color, data, showSymbol } = series;
  return {
    type: 'line',
    name,
    showSymbol,
    symbolSize: 8,
    data,
    color,
    lineStyle: { width: 2, color, cap: 'round', join: 'round' },
    itemStyle: { color, borderColor: theme.tooltipBackground, borderWidth: 2 },
    emphasis: { disabled: true },
    ...extra,
  };
}

/**
 * A bar series by the chart rules: bars at most 24px wide that dim slightly on hover. The caller
 * styles the bars (colour, which corners are rounded) and adds what it needs in `extra` (a stack).
 */
export function barSeries(
  series: {
    name: string;
    data: BarSeriesOption['data'];
    itemStyle: NonNullable<BarSeriesOption['itemStyle']>;
  },
  extra: BarSeriesOption = {},
): BarSeriesOption {
  return {
    type: 'bar',
    name: series.name,
    barMaxWidth: 24,
    data: series.data,
    itemStyle: series.itemStyle,
    emphasis: { itemStyle: { opacity: 0.85 } },
    ...extra,
  };
}

/** Escapes text for the HTML tooltips (skill names and labels are data, never markup). */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * One tooltip row: a key in the series colour (a short line for line charts, a square for bars), the
 * value strong, the label after. Value and label are escaped.
 */
export function tooltipRow(
  color: string,
  value: string,
  label: string,
  key: 'line' | 'square' = 'line',
): string {
  const shape =
    key === 'line'
      ? 'width:10px;height:2px;border-radius:1px'
      : 'width:8px;height:8px;border-radius:2px';
  return (
    `<div style="display:flex;align-items:center;gap:6px">` +
    `<span style="display:inline-block;${shape};background:${color}"></span>` +
    `<strong>${escapeHtml(value)}</strong><span style="opacity:.7">${escapeHtml(label)}</span></div>`
  );
}

/** The muted first line of a tooltip (which x position it is about); escaped. */
export function tooltipTitle(text: string): string {
  return `<div style="opacity:.7;margin-bottom:2px">${escapeHtml(text)}</div>`;
}

/** The first axis-trigger param ECharts hands a tooltip formatter (typed loosely by ECharts). */
export function firstParam(params: unknown): { value: unknown; dataIndex?: number } | null {
  const list: unknown[] = Array.isArray(params) ? params : [params];
  const first = list[0];
  return typeof first === 'object' && first !== null
    ? (first as { value: unknown; dataIndex?: number })
    : null;
}

// --- The account page's charts -------------------------------------------------------------------

/** "29 Sep 2026, 14:05": a moment in a tooltip, with the year (a range can span several). */
const MOMENT_OPTIONS: Intl.DateTimeFormatOptions = { ...DATE_TIME_OPTIONS, year: 'numeric' };
const DATE_UTC = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});
const SHORT_DAY_UTC = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});

/** Compact axis labels: 13_200_000 → "13.2M" (formatGp's units, which read fine for XP too). */
function compact(value: number): string {
  return formatGp(value);
}

/** "2026-09-29" → "Sep 29" (the day is a calendar date: formatted in UTC so it never shifts). */
function shortDay(day: string): string {
  const t = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(t) ? SHORT_DAY_UTC.format(new Date(t)) : day;
}

/** "2026-09-29" → "Sep 29, 2026", the title of a day's tooltip (a calendar date: UTC again). */
function longDay(day: string): string {
  return DATE_UTC.format(new Date(`${day}T00:00:00Z`));
}

/**
 * Points of a change-only XP series ready for a step chart: [ms, xp] in time order, with the last
 * value carried to `to` (XP only changes when a new bucket is written, so the latest value holds until
 * now). Points after `to` are dropped; an empty series stays empty.
 */
export function stepPoints(points: readonly [string, number][], to: Date): [number, number][] {
  const end = to.getTime();
  const out: [number, number][] = [];
  for (const [iso, xp] of points) {
    const t = Date.parse(iso);
    if (Number.isFinite(t) && Number.isFinite(xp) && t <= end) out.push([t, xp]);
  }
  out.sort((a, b) => a[0] - b[0]);
  const last = out.at(-1);
  if (last && last[0] < end) out.push([end, last[1]]);
  return out;
}

export interface XpChartInput {
  skill: string;
  points: readonly [string, number][];
  from: Date;
  to: Date;
  /** The viewer's time zone (Settings): the tooltip's date and time are shown in it. */
  timezone: string;
}

/**
 * Below this share of the window a line is too short to see (a history that began minutes ago in a
 * 30-day range), so its points are drawn as dots.
 */
const MIN_VISIBLE_LINE_SHARE = 0.02;

/**
 * The XP chart: one step line (`step: 'end'`: XP is change-only and monotonic, so a value holds until
 * the next change instead of interpolating between samples), a 10% area wash, a crosshair tooltip
 * with the exact XP and the moment in the viewer's time zone (like the rest of the account page, not
 * the browser's). The y-axis fits the data (XP ranges are far from zero). A line covering only a
 * sliver of the window (a new account) gets dots, so the chart isn't blank.
 */
export function xpChartOption(input: XpChartInput, theme: ChartTheme): ChartOption {
  const data = stepPoints(input.points, input.to);
  const color = theme.series[0];
  const windowMs = input.to.getTime() - input.from.getTime();
  const first = data[0];
  const last = data.at(-1);
  const spanMs = first && last ? last[0] - first[0] : 0;
  const showSymbol = data.length > 0 && spanMs < windowMs * MIN_VISIBLE_LINE_SHARE;
  return {
    ...baseOption(theme),
    tooltip: axisTooltip(theme, 'line', (params) => {
      const p = firstParam(params);
      const value = Array.isArray(p?.value) ? (p.value as [number, number]) : null;
      if (!value) return '';
      return (
        tooltipTitle(formatInZone(new Date(value[0]), input.timezone, MOMENT_OPTIONS) ?? '') +
        tooltipRow(color, `${formatNumber(value[1])} XP`, input.skill)
      );
    }),
    xAxis: timeAxis(theme, input.from, input.to),
    yAxis: valueAxis(theme, { scale: true, format: compact }),
    series: [
      lineSeries(
        theme,
        { name: input.skill, color, data, showSymbol },
        { step: 'end', areaStyle: { color, opacity: 0.1 } },
      ),
    ],
  };
}

export interface PlaytimeDay {
  /** Local calendar day, YYYY-MM-DD. */
  day: string;
  /** Milliseconds played that day. */
  ms: number;
}

/** Playtime per day: bars (≤ 24px, 4px rounded tops) in hours, tooltip with the exact duration. */
export function playtimeOption(days: readonly PlaytimeDay[], theme: ChartTheme): ChartOption {
  const color = theme.series[0];
  return {
    ...baseOption(theme),
    tooltip: axisTooltip(theme, 'shadow', (params) => {
      const entry = days[firstParam(params)?.dataIndex ?? -1];
      if (!entry) return '';
      return (
        tooltipTitle(longDay(entry.day)) +
        tooltipRow(color, formatDuration(entry.ms / 1000), 'played')
      );
    }),
    xAxis: categoryAxis(
      theme,
      days.map((d) => shortDay(d.day)),
    ),
    yAxis: valueAxis(theme, { minInterval: 1, format: (v) => `${v}h` }),
    series: [
      barSeries({
        name: 'Playtime',
        data: days.map((d) => Math.round((d.ms / 3_600_000) * 100) / 100),
        itemStyle: { color, borderRadius: [4, 4, 0, 0] },
      }),
    ],
  };
}

export interface WealthPoint {
  /** UTC day, YYYY-MM-DD. */
  day: string;
  lastValue: number;
  maxValue: number;
}

export const WEALTH_SERIES = { last: 'End of day', max: 'Daily high' } as const;

const DAY_MS = 24 * 60 * 60 * 1000;
/** Most days the wealth chart spans (a longer history keeps its newest days). */
const MAX_WEALTH_DAYS = 400;

/**
 * Every UTC day from the first to the last in `days` (oldest first), each with its values or null
 * where the hub has no row for that day (the account wasn't seen with a shared inventory then).
 * Capped at the newest MAX_WEALTH_DAYS days; malformed day strings are dropped.
 */
export function wealthCalendar(
  days: readonly WealthPoint[],
): { day: string; lastValue: number | null; maxValue: number | null }[] {
  const byDay = new Map<number, WealthPoint>();
  for (const d of days) {
    const t = Date.parse(`${d.day}T00:00:00Z`);
    if (Number.isFinite(t)) byDay.set(t, d);
  }
  if (byDay.size === 0) return [];
  const times = [...byDay.keys()];
  const last = Math.max(...times);
  const first = Math.max(Math.min(...times), last - (MAX_WEALTH_DAYS - 1) * DAY_MS);
  const out: { day: string; lastValue: number | null; maxValue: number | null }[] = [];
  for (let t = first; t <= last; t += DAY_MS) {
    const d = byDay.get(t);
    out.push({
      day: new Date(t).toISOString().slice(0, 10),
      lastValue: d ? d.lastValue : null,
      maxValue: d ? d.maxValue : null,
    });
  }
  return out;
}

/**
 * Carried wealth per day: two lines (end of day and the day's high) on one GP axis over every day of
 * the period (days without data are gaps the line bridges), with a legend (two series) and a
 * crosshair tooltip listing both.
 */
export function wealthOption(days: readonly WealthPoint[], theme: ChartTheme): ChartOption {
  const [lastColor, maxColor] = theme.series;
  const calendar = wealthCalendar(days);
  const showSymbol = calendar.length <= 31;
  const line = (name: string, color: string, values: (number | null)[]) =>
    lineSeries(theme, { name, color, data: values, showSymbol }, { connectNulls: true });
  return {
    ...baseOption(theme, { legend: true }),
    legend: {
      ...legend(theme, [WEALTH_SERIES.last, WEALTH_SERIES.max], { width: 12, height: 3 }),
      // The series' itemStyle (a 2px border in the card colour, for the dots) would otherwise draw
      // over the 3px key and make it invisible.
      itemStyle: { borderWidth: 0 },
    },
    tooltip: axisTooltip(theme, 'line', (params) => {
      const entry = calendar[firstParam(params)?.dataIndex ?? -1];
      if (!entry) return '';
      const title = tooltipTitle(longDay(entry.day));
      if (entry.lastValue === null || entry.maxValue === null) {
        return title + '<div style="opacity:.7">No data this day</div>';
      }
      return (
        title +
        tooltipRow(lastColor, `${formatGp(entry.lastValue)} gp`, WEALTH_SERIES.last) +
        tooltipRow(maxColor, `${formatGp(entry.maxValue)} gp`, WEALTH_SERIES.max)
      );
    }),
    xAxis: categoryAxis(
      theme,
      calendar.map((d) => shortDay(d.day)),
      { boundaryGap: false },
    ),
    yAxis: valueAxis(theme, { scale: true, format: compact }),
    series: [
      line(
        WEALTH_SERIES.last,
        lastColor,
        calendar.map((d) => d.lastValue),
      ),
      line(
        WEALTH_SERIES.max,
        maxColor,
        calendar.map((d) => d.maxValue),
      ),
    ],
  };
}

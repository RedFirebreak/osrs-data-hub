/**
 * ECharts options for the account page's charts (XP, playtime, wealth), built from plain data and a
 * resolved ChartTheme. Pure: no DOM and no echarts runtime (type-only imports), so the builders are
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

/** Escapes text for the HTML tooltips (skill names and labels are data, never markup). */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const DATE_TIME = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});
const DATE_UTC = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});

/** Compact axis labels: 13_200_000 → "13.2M" (formatGp's units, which read fine for XP too). */
function compact(value: number): string {
  return formatGp(value);
}

function tooltipBase(theme: ChartTheme): TooltipComponentOption {
  return {
    confine: true,
    backgroundColor: theme.tooltipBackground,
    borderColor: theme.tooltipBorder,
    borderWidth: 1,
    padding: [6, 10],
    textStyle: { color: theme.text, fontFamily: theme.fontFamily, fontSize: 12 },
    extraCssText: 'border-radius: 8px; box-shadow: 0 4px 12px rgb(0 0 0 / 0.12);',
  };
}

function gridBase(): GridComponentOption {
  return {
    left: 4,
    right: 12,
    top: 12,
    bottom: 4,
    outerBoundsMode: 'same',
    outerBoundsContain: 'axisLabel',
  };
}

function axisLabel(theme: ChartTheme) {
  return { color: theme.mutedText, fontFamily: theme.fontFamily, fontSize: 11 };
}

/** One tooltip row: a short line key in the series colour, the value strong, the label after. */
function tooltipRow(color: string, value: string, label: string): string {
  return (
    `<div style="display:flex;align-items:center;gap:6px">` +
    `<span style="display:inline-block;width:10px;height:2px;border-radius:1px;background:${color}"></span>` +
    `<strong>${escapeHtml(value)}</strong><span style="opacity:.7">${escapeHtml(label)}</span></div>`
  );
}

function tooltipTitle(text: string): string {
  return `<div style="opacity:.7;margin-bottom:2px">${escapeHtml(text)}</div>`;
}

/** The first axis-trigger param ECharts hands a tooltip formatter (typed loosely by ECharts). */
function firstParam(params: unknown): { value: unknown; dataIndex?: number } | null {
  const list: unknown[] = Array.isArray(params) ? params : [params];
  const first = list[0];
  return typeof first === 'object' && first !== null
    ? (first as { value: unknown; dataIndex?: number })
    : null;
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
}

/**
 * Below this share of the window a line is too short to see (a history that began minutes ago in a
 * 30-day range), so its points are drawn as dots.
 */
const MIN_VISIBLE_LINE_SHARE = 0.02;

/**
 * The XP chart: one step line (`step: 'end'`: XP is change-only and monotonic, so a value holds until
 * the next change instead of interpolating between samples), a 10% area wash, a crosshair tooltip
 * with the exact XP. The y-axis fits the data (XP ranges are far from zero). A line covering only a
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
    animation: false,
    textStyle: { fontFamily: theme.fontFamily },
    grid: gridBase(),
    tooltip: {
      ...tooltipBase(theme),
      trigger: 'axis',
      axisPointer: { type: 'line', lineStyle: { color: theme.mutedText, width: 1 } },
      formatter: (params: unknown) => {
        const p = firstParam(params);
        const value = Array.isArray(p?.value) ? (p.value as [number, number]) : null;
        if (!value) return '';
        return (
          tooltipTitle(DATE_TIME.format(new Date(value[0]))) +
          tooltipRow(color, `${formatNumber(value[1])} XP`, input.skill)
        );
      },
    },
    xAxis: {
      type: 'time',
      min: input.from.getTime(),
      max: input.to.getTime(),
      axisLine: { lineStyle: { color: theme.grid } },
      axisTick: { show: false },
      axisLabel: { ...axisLabel(theme), hideOverlap: true },
      splitLine: { show: false },
    },
    yAxis: {
      type: 'value',
      scale: true,
      axisLabel: { ...axisLabel(theme), formatter: (v: number) => compact(v) },
      splitLine: { lineStyle: { color: theme.grid, width: 1 } },
    },
    series: [
      {
        type: 'line',
        name: input.skill,
        step: 'end',
        showSymbol,
        symbolSize: 8,
        data,
        color,
        lineStyle: { width: 2, color, cap: 'round', join: 'round' },
        itemStyle: { color, borderColor: theme.tooltipBackground, borderWidth: 2 },
        areaStyle: { color, opacity: 0.1 },
        emphasis: { disabled: true },
      },
    ],
  };
}

export interface PlaytimeDay {
  /** Local calendar day, YYYY-MM-DD. */
  day: string;
  /** Milliseconds played that day. */
  ms: number;
}

/** "2026-09-29" → "Sep 29" (the day is a calendar date: formatted in UTC so it never shifts). */
function shortDay(day: string): string {
  const t = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(t)) return day;
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(t));
}

/** Playtime per day: bars (≤ 24px, 4px rounded tops) in hours, tooltip with the exact duration. */
export function playtimeOption(days: readonly PlaytimeDay[], theme: ChartTheme): ChartOption {
  const color = theme.series[0];
  return {
    animation: false,
    textStyle: { fontFamily: theme.fontFamily },
    grid: gridBase(),
    tooltip: {
      ...tooltipBase(theme),
      trigger: 'axis',
      axisPointer: { type: 'shadow', shadowStyle: { opacity: 0.08 } },
      formatter: (params: unknown) => {
        const entry = days[firstParam(params)?.dataIndex ?? -1];
        if (!entry) return '';
        return (
          tooltipTitle(DATE_UTC.format(new Date(`${entry.day}T00:00:00Z`))) +
          tooltipRow(color, formatDuration(entry.ms / 1000), 'played')
        );
      },
    },
    xAxis: {
      type: 'category',
      data: days.map((d) => shortDay(d.day)),
      axisLine: { lineStyle: { color: theme.grid } },
      axisTick: { show: false },
      axisLabel: { ...axisLabel(theme), hideOverlap: true },
    },
    yAxis: {
      type: 'value',
      minInterval: 1,
      axisLabel: { ...axisLabel(theme), formatter: (v: number) => `${v}h` },
      splitLine: { lineStyle: { color: theme.grid, width: 1 } },
    },
    series: [
      {
        type: 'bar',
        name: 'Playtime',
        barMaxWidth: 24,
        data: days.map((d) => Math.round((d.ms / 3_600_000) * 100) / 100),
        itemStyle: { color, borderRadius: [4, 4, 0, 0] },
        emphasis: { itemStyle: { opacity: 0.85 } },
      },
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
    ({
      type: 'line',
      name,
      showSymbol,
      symbolSize: 8,
      connectNulls: true,
      data: values,
      color,
      lineStyle: { width: 2, color, cap: 'round', join: 'round' },
      itemStyle: { color, borderColor: theme.tooltipBackground, borderWidth: 2 },
      emphasis: { disabled: true },
    }) satisfies LineSeriesOption;
  return {
    animation: false,
    textStyle: { fontFamily: theme.fontFamily },
    grid: { ...gridBase(), top: 36 },
    legend: {
      top: 0,
      left: 0,
      icon: 'roundRect',
      itemWidth: 12,
      itemHeight: 3,
      // The series' itemStyle (a 2px border in the card colour, for the dots) would otherwise draw
      // over the 3px key and make it invisible.
      itemStyle: { borderWidth: 0 },
      textStyle: { color: theme.mutedText, fontFamily: theme.fontFamily, fontSize: 12 },
      data: [WEALTH_SERIES.last, WEALTH_SERIES.max],
    },
    tooltip: {
      ...tooltipBase(theme),
      trigger: 'axis',
      axisPointer: { type: 'line', lineStyle: { color: theme.mutedText, width: 1 } },
      formatter: (params: unknown) => {
        const entry = calendar[firstParam(params)?.dataIndex ?? -1];
        if (!entry) return '';
        const title = tooltipTitle(DATE_UTC.format(new Date(`${entry.day}T00:00:00Z`)));
        if (entry.lastValue === null || entry.maxValue === null) {
          return title + '<div style="opacity:.7">No data this day</div>';
        }
        return (
          title +
          tooltipRow(lastColor, `${formatGp(entry.lastValue)} gp`, WEALTH_SERIES.last) +
          tooltipRow(maxColor, `${formatGp(entry.maxValue)} gp`, WEALTH_SERIES.max)
        );
      },
    },
    xAxis: {
      type: 'category',
      boundaryGap: false,
      data: calendar.map((d) => shortDay(d.day)),
      axisLine: { lineStyle: { color: theme.grid } },
      axisTick: { show: false },
      axisLabel: { ...axisLabel(theme), hideOverlap: true },
    },
    yAxis: {
      type: 'value',
      scale: true,
      axisLabel: { ...axisLabel(theme), formatter: (v: number) => compact(v) },
      splitLine: { lineStyle: { color: theme.grid, width: 1 } },
    },
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

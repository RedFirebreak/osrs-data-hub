/**
 * ECharts options of the Metrics charts (D-106): the period comparison, the effective-hours heatmap,
 * the sessions scatter, the rate through a session, where the time goes, a session's timeline and
 * the boss trends. Built from the read models' plain data and a resolved ChartTheme with the shared
 * parts of charts/options.ts, so they follow the same rules: one y-axis, 2px lines, bars at most
 * 24px wide, text in text colours, a legend for 2+ series. Pure (type-only echarts imports), so they
 * are unit-tested in the node project.
 *
 * Colour: an activity, skill or boss keeps its colour across the page's charts (`activityColors`,
 * from one fixed order); the three categorical colours go to the first three names of that order and
 * everything else is "Other" in a neutral grey, never a fourth hue. Magnitude (the heatmap) is one
 * blue, light to dark.
 */
import {
  HOUR_MS,
  METRICS_BUCKET_MS,
  OTHER_ACTIVITY,
  formatNumber,
  heatValue,
  rateOf,
  type HeatCell,
  type MetricsMeasure,
  type PeriodComparison,
  type RateStep,
  type TimeByActivity,
} from '@hub/core';
import type { BossPeriod, SessionCard, SessionTimeline, TimelineMarker } from '@hub/server';
import {
  MOMENT_OPTIONS,
  axisTooltip,
  barSeries,
  baseOption,
  categoryAxis,
  compact,
  escapeHtml,
  firstParam,
  legend,
  lineSeries,
  longDay,
  shortDay,
  timeAxis,
  tooltipRow,
  tooltipTitle,
  valueAxis,
  type ChartOption,
  type ChartTheme,
} from '@/components/charts/options';
import { formatInZone } from '@/lib/dates';
import {
  MEASURE_LABELS,
  WEEKDAYS,
  formatAmount,
  formatAxisAmount,
  formatAxisRate,
  formatHour,
  formatMs,
  formatRate,
  formatSessionMinute,
} from './format';

// --- Colour --------------------------------------------------------------------------------------

/** "Other": a neutral grey that reads on both card surfaces and is no categorical hue. */
export function otherColor(theme: ChartTheme): string {
  return theme.dark ? '#6f6f6f' : '#a8a8a8';
}

/**
 * The sequential ramp of the heatmap, light to dark in light mode and dark to light in dark mode, so
 * "more" is always further from the card.
 */
export function heatRamp(theme: ChartTheme): string[] {
  return theme.dark ? ['#1c2b3e', '#2f6fbd', '#8fbcf2'] : ['#e3eefb', '#5b98e0', '#174a8a'];
}

/**
 * Colours by name: the first three names of `order` get the categorical colours in order, then the
 * names of `extra` that aren't in it fill the slots left; everything else is Other.
 */
export function activityColors(
  theme: ChartTheme,
  order: readonly string[],
  extra: readonly string[] = [],
): (name: string) => string {
  const named = [...new Set([...order, ...extra])]
    .filter((n) => n !== OTHER_ACTIVITY)
    .slice(0, theme.series.length);
  const colors = new Map(named.map((n, i) => [n, theme.series[i]!]));
  return (name) => colors.get(name) ?? otherColor(theme);
}

/** The names that get their own colour (activityColors' first three); the rest fold into Other. */
export function namedActivities(order: readonly string[], extra: readonly string[] = []): string[] {
  return [...new Set([...order, ...extra])].filter((n) => n !== OTHER_ACTIVITY).slice(0, 3);
}

/** A tooltip on one mark (scatter dots, heatmap cells, timeline markers). */
function itemTooltip(theme: ChartTheme, formatter: (params: unknown) => string) {
  const axis = axisTooltip(theme, 'line', formatter);
  return { ...axis, trigger: 'item' as const, axisPointer: undefined };
}

/** The params of an item-trigger tooltip or a click (ECharts types them loosely). */
export function itemParam(params: unknown): {
  seriesName?: string;
  dataIndex?: number;
  value?: unknown;
  data?: unknown;
} | null {
  return typeof params === 'object' && params !== null
    ? (params as { seriesName?: string; dataIndex?: number; value?: unknown; data?: unknown })
    : null;
}

// --- Period comparison ---------------------------------------------------------------------------

export const COMPARISON_SERIES = { current: 'This period', previous: 'Previous period' } as const;

export interface ComparisonChartInput {
  comparison: PeriodComparison;
  measure: MetricsMeasure;
  /** The range (ISO). */
  from: string;
  to: string;
  timezone: string;
}

/**
 * Cumulative amount of the measure through the range, with the period before it overlaid on the same
 * x positions (shifted by one span) when asked for. The x-axis is the range's time, so a brush on it
 * selects a span of the range (`brush` is set; the client turns the pointer into it).
 */
export function comparisonOption(input: ComparisonChartInput, theme: ChartTheme): ChartOption {
  const from = new Date(input.from);
  const to = new Date(input.to);
  const [currentColor, previousColor] = theme.series;
  const at = (offset: number) => from.getTime() + offset;
  const current = input.comparison.current.map(([o, v]) => [at(o), v] as [number, number]);
  const previous =
    input.comparison.previous?.map(([o, v]) => [at(o), v] as [number, number]) ?? null;
  const both = previous !== null;
  return {
    ...baseOption(theme, { legend: both }),
    ...(both
      ? {
          legend: {
            ...legend(theme, [COMPARISON_SERIES.current, COMPARISON_SERIES.previous], {
              width: 12,
              height: 3,
            }),
            itemStyle: { borderWidth: 0 },
          },
        }
      : {}),
    tooltip: axisTooltip(theme, 'line', (params) => {
      const list: unknown[] = Array.isArray(params) ? params : [params];
      const p = firstParam(params);
      const value = Array.isArray(p?.value) ? (p.value as [number, number]) : null;
      if (!value) return '';
      let html = tooltipTitle(
        formatInZone(new Date(value[0]), input.timezone, MOMENT_OPTIONS) ?? '',
      );
      for (const item of list) {
        const it = itemParam(item);
        const v = Array.isArray(it?.value) ? (it.value as [number, number])[1] : null;
        if (v === null || v === undefined) continue;
        const color = it?.seriesName === COMPARISON_SERIES.previous ? previousColor : currentColor;
        html += tooltipRow(color, formatAmount(input.measure, v), it?.seriesName ?? '');
      }
      return html;
    }),
    xAxis: timeAxis(theme, from, to),
    // Amounts are whole numbers: without this a flat range labels its axis 0, 0, 0, 1, 1, 1.
    yAxis: valueAxis(theme, {
      minInterval: 1,
      format: (v) => formatAxisAmount(input.measure, v),
    }),
    // The brush brings the toolbox's brush buttons along; the drag is all it needs.
    toolbox: { show: false },
    brush: {
      xAxisIndex: 0,
      brushType: 'lineX',
      brushMode: 'single',
      transformable: false,
      throttleType: 'debounce',
      throttleDelay: 300,
      brushStyle: {
        borderWidth: 1,
        color: 'rgba(120, 120, 120, 0.12)',
        borderColor: theme.mutedText,
      },
      outOfBrush: { colorAlpha: 0.35 },
    },
    series: [
      lineSeries(
        theme,
        { name: COMPARISON_SERIES.current, color: currentColor, data: current, showSymbol: false },
        { areaStyle: { color: currentColor, opacity: 0.1 } },
      ),
      ...(previous
        ? [
            lineSeries(theme, {
              name: COMPARISON_SERIES.previous,
              color: previousColor,
              data: previous,
              showSymbol: false,
            }),
          ]
        : []),
    ],
  };
}

/** The span a brush selected, in ms; null for a cleared brush or a sliver under one bucket. */
export function brushedSpan(params: unknown): { from: number; to: number } | null {
  const areas = (params as { areas?: { coordRange?: unknown }[] } | null)?.areas;
  const range = areas?.[0]?.coordRange;
  if (!Array.isArray(range) || range.length !== 2) return null;
  const [a, b] = range.map(Number) as [number, number];
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  const from = Math.min(a, b);
  const to = Math.max(a, b);
  return to - from < METRICS_BUCKET_MS ? null : { from, to };
}

// --- Heatmap -------------------------------------------------------------------------------------

/** What a heatmap cell is coloured by, in words. */
export function heatLabel(measure: MetricsMeasure): string {
  return measure === 'active' ? 'active minutes' : `${MEASURE_LABELS[measure]} per active hour`;
}

/** Weekday × hour, Monday on top, coloured by heatValue; cells without play are left empty. */
export function heatmapOption(
  cells: readonly HeatCell[],
  measure: MetricsMeasure,
  theme: ChartTheme,
): ChartOption {
  const sel = { measure };
  const values = cells.map((c) => (c.onlineMs > 0 ? (heatValue(c, sel) ?? 0) : null));
  const max = Math.max(1, ...values.map((v) => v ?? 0));
  const hours = Array.from({ length: 24 }, (_, h) => String(h));
  return {
    animation: false,
    textStyle: { fontFamily: theme.fontFamily },
    grid: {
      left: 4,
      right: 8,
      top: 4,
      bottom: 44,
      outerBoundsMode: 'same',
      outerBoundsContain: 'axisLabel',
    },
    tooltip: itemTooltip(theme, (params) => {
      const p = itemParam(params);
      const cell = cells[p?.dataIndex ?? -1];
      if (!cell) return '';
      const title = `${WEEKDAYS[cell.weekday]} ${formatHour(cell.hour)}–${formatHour(cell.hour + 1)}`;
      if (cell.onlineMs === 0) return tooltipTitle(title) + '<div style="opacity:.7">No play</div>';
      const v = heatValue(cell, sel);
      return (
        tooltipTitle(title) +
        `<div><strong>${escapeHtml(
          measure === 'active' ? `${formatNumber(v ?? 0)} min` : formatRate(measure, v),
        )}</strong> <span style="opacity:.7">${escapeHtml(heatLabel(measure))}</span></div>` +
        `<div style="opacity:.7">${escapeHtml(
          `${formatMs(cell.activeMs)} active of ${formatMs(cell.onlineMs)} online, ${cell.sessions} ${
            cell.sessions === 1 ? 'session' : 'sessions'
          }`,
        )}</div>`
      );
    }),
    xAxis: {
      type: 'category',
      data: hours,
      splitArea: { show: false },
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: {
        color: theme.mutedText,
        fontFamily: theme.fontFamily,
        fontSize: 11,
        interval: 2,
      },
    },
    yAxis: {
      type: 'category',
      data: [...WEEKDAYS],
      inverse: true,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: theme.mutedText, fontFamily: theme.fontFamily, fontSize: 11 },
    },
    visualMap: {
      type: 'continuous',
      min: 0,
      max,
      calculable: false,
      orient: 'horizontal',
      left: 'center',
      bottom: 0,
      itemHeight: 120,
      itemWidth: 10,
      precision: 0,
      text: [measure === 'active' ? `${formatNumber(max)} min` : formatAxisRate(measure, max), '0'],
      textStyle: { color: theme.mutedText, fontFamily: theme.fontFamily, fontSize: 11 },
      inRange: { color: heatRamp(theme) },
    },
    series: [
      {
        type: 'heatmap',
        name: heatLabel(measure),
        data: cells.map((c, i) => [c.hour, c.weekday, values[i] ?? '-']),
        itemStyle: { borderColor: theme.tooltipBackground, borderWidth: 2, borderRadius: 3 },
        emphasis: { itemStyle: { borderColor: theme.text, borderWidth: 1 } },
        cursor: 'pointer',
      },
    ],
  };
}

// --- Sessions scatter ----------------------------------------------------------------------------

export interface ScatterInput {
  sessions: readonly SessionCard[];
  measure: MetricsMeasure;
  /** The page's activity order (most sessions first): the colours. */
  activities: readonly string[];
  timezone: string;
}

/** "15m" under an hour, "1.5h" from there. */
export function hoursAxis(hours: number): string {
  return hours > 0 && hours < 1 ? `${Math.round(hours * 60)}m` : `${Math.round(hours * 10) / 10}h`;
}

/** A session's rate of the measure per online hour (the active share for `active`). */
export function sessionRate(s: SessionCard, measure: MetricsMeasure): number | null {
  return rateOf({ measure }, s.value, s.onlineMs);
}

/**
 * One dot per session: hours online against the rate of the measure, coloured by its main activity
 * (three named ones and Other). Each dot carries the session's id for the click.
 */
export function scatterOption(input: ScatterInput, theme: ChartTheme): ChartOption {
  const named = namedActivities(input.activities);
  const color = activityColors(theme, input.activities);
  const groups = [...named, OTHER_ACTIVITY]
    .map((name) => ({
      name,
      sessions: input.sessions.filter((s) =>
        name === OTHER_ACTIVITY ? !named.includes(s.main?.name ?? '') : s.main?.name === name,
      ),
    }))
    .filter((g) => g.sessions.length > 0);
  const byId = new Map(input.sessions.map((s) => [s.id, s]));
  return {
    ...baseOption(theme, { legend: groups.length > 1 }),
    ...(groups.length > 1
      ? {
          legend: legend(
            theme,
            groups.map((g) => g.name),
            { width: 10, height: 10 },
          ),
        }
      : {}),
    tooltip: itemTooltip(theme, (params) => {
      const p = itemParam(params);
      const id = (p?.data as { id?: string } | undefined)?.id;
      const s = id ? byId.get(id) : undefined;
      if (!s) return '';
      return (
        tooltipTitle(formatInZone(s.start, input.timezone, MOMENT_OPTIONS) ?? '') +
        tooltipRow(
          color(s.main && named.includes(s.main.name) ? s.main.name : OTHER_ACTIVITY),
          formatRate(input.measure, sessionRate(s, input.measure)),
          s.main?.name ?? 'No main activity',
          'square',
        ) +
        `<div style="opacity:.7">${escapeHtml(
          `${formatMs(s.onlineMs)} online · ${formatAmount(input.measure, s.value)}`,
        )}</div>`
      );
    }),
    xAxis: {
      type: 'value',
      min: 0,
      // At least an hour wide, in half hours, so a few short sessions don't read 0.002h, 0.004h.
      max: (extent: { max: number }) => Math.max(1, extent.max),
      minInterval: 0.5,
      axisLine: { lineStyle: { color: theme.grid } },
      axisTick: { show: false },
      axisLabel: {
        color: theme.mutedText,
        fontFamily: theme.fontFamily,
        fontSize: 11,
        formatter: (v: number) => `${v}h`,
      },
      splitLine: { show: false },
    },
    yAxis: valueAxis(theme, {
      ...(input.sessions.every((s) => s.value === 0) ? { minInterval: 1 } : {}),
      format: (v) => formatAxisRate(input.measure, v),
    }),
    series: groups.map((g) => ({
      type: 'scatter',
      name: g.name,
      symbolSize: 10,
      cursor: 'pointer',
      itemStyle: { color: color(g.name), borderColor: theme.tooltipBackground, borderWidth: 2 },
      emphasis: { scale: 1.3 },
      data: g.sessions.map((s) => ({
        id: s.id,
        value: [Math.round((s.onlineMs / HOUR_MS) * 100) / 100, sessionRate(s, input.measure) ?? 0],
      })),
    })),
  };
}

// --- Rate through a session ----------------------------------------------------------------------

/** "0:00–0:30": the label of one step of the rate-through chart. */
export function stepLabel(step: RateStep, stepMinutes = 30): string {
  return `${formatSessionMinute(step.minute)}–${formatSessionMinute(step.minute + stepMinutes)}`;
}

/**
 * The median rate by time into the session with the middle half as a band: the band is two stacked
 * lines (the lower quartile, invisible, and the width of the band, filled), so it needs no second
 * axis.
 */
export function rateThroughOption(
  steps: readonly RateStep[],
  measure: MetricsMeasure,
  theme: ChartTheme,
): ChartOption {
  const color = theme.series[0];
  const showSymbol = steps.length <= 2;
  return {
    ...baseOption(theme),
    tooltip: axisTooltip(theme, 'line', (params) => {
      const step = steps[firstParam(params)?.dataIndex ?? -1];
      if (!step) return '';
      return (
        tooltipTitle(`${stepLabel(step)} into the session`) +
        tooltipRow(color, formatRate(measure, step.median), 'median') +
        `<div style="opacity:.7">${escapeHtml(
          `Middle half ${formatRate(measure, step.p25)} to ${formatRate(measure, step.p75)}, ${
            step.sessions
          } ${step.sessions === 1 ? 'session' : 'sessions'}`,
        )}</div>`
      );
    }),
    xAxis: categoryAxis(
      theme,
      steps.map((s) => formatSessionMinute(s.minute)),
      { boundaryGap: false },
    ),
    yAxis: valueAxis(theme, { format: (v) => formatAxisRate(measure, v) }),
    series: [
      lineSeries(
        theme,
        { name: 'Lower quartile', color, data: steps.map((s) => s.p25), showSymbol: false },
        { stack: 'band', lineStyle: { opacity: 0 }, tooltip: { show: false }, silent: true },
      ),
      lineSeries(
        theme,
        {
          name: 'Middle half',
          color,
          data: steps.map((s) => s.p75 - s.p25),
          showSymbol: false,
        },
        {
          stack: 'band',
          lineStyle: { opacity: 0 },
          areaStyle: { color, opacity: 0.15 },
          silent: true,
        },
      ),
      lineSeries(theme, {
        name: 'Median',
        color,
        data: steps.map((s) => s.median),
        showSymbol,
      }),
    ],
  };
}

// --- Where the time goes -------------------------------------------------------------------------

/**
 * Folds the activities of `data` into the page's three named ones and Other (activityColors), so the
 * stacks wear the same colours as the scatter.
 */
export function foldTimeByActivity(
  data: TimeByActivity,
  order: readonly string[],
): { name: string; ms: number[] }[] {
  const named = namedActivities(
    order,
    data.series.map((s) => s.name),
  );
  const other = data.days.map(() => 0);
  const out: { name: string; ms: number[] }[] = named
    .map((name) => ({
      name,
      ms: data.series.find((s) => s.name === name)?.ms ?? data.days.map(() => 0),
    }))
    .filter((s) => s.ms.some((v) => v > 0));
  for (const s of data.series) {
    if (named.includes(s.name)) continue;
    s.ms.forEach((v, i) => (other[i]! += v));
  }
  if (other.some((v) => v > 0)) out.push({ name: OTHER_ACTIVITY, ms: other });
  return out;
}

/** Active hours per activity per day, stacked (2px gaps between the segments). */
export function timeByActivityOption(
  data: TimeByActivity,
  order: readonly string[],
  theme: ChartTheme,
): ChartOption {
  const series = foldTimeByActivity(data, order);
  const color = activityColors(
    theme,
    order,
    data.series.map((s) => s.name),
  );
  return {
    ...baseOption(theme, { legend: series.length > 1 }),
    ...(series.length > 1
      ? {
          legend: legend(
            theme,
            series.map((s) => s.name),
            { width: 10, height: 10 },
          ),
        }
      : {}),
    tooltip: axisTooltip(theme, 'shadow', (params) => {
      const i = firstParam(params)?.dataIndex ?? -1;
      const day = data.days[i];
      if (!day) return '';
      const rows = series
        .filter((s) => (s.ms[i] ?? 0) > 0)
        .map((s) => tooltipRow(color(s.name), formatMs(s.ms[i]!), s.name, 'square'))
        .join('');
      return tooltipTitle(longDay(day)) + (rows || '<div style="opacity:.7">No active time</div>');
    }),
    xAxis: categoryAxis(
      theme,
      data.days.map((d) => shortDay(d)),
    ),
    // Active time comes in 5-minute stretches: a short day reads 5m, 10m rather than 0.08h.
    yAxis: valueAxis(theme, { minInterval: 5 / 60, format: hoursAxis }),
    series: series.map((s) =>
      barSeries(
        {
          name: s.name,
          data: s.ms.map((ms) => Math.round((ms / HOUR_MS) * 100) / 100),
          itemStyle: { color: color(s.name), borderColor: theme.tooltipBackground, borderWidth: 1 },
        },
        { stack: 'time' },
      ),
    ),
  };
}

// --- Session timeline ----------------------------------------------------------------------------

export const MARKER_LABELS: Readonly<Record<TimelineMarker['type'], string>> = {
  loot: 'Drops',
  pk_loot: 'Drops',
  level_up: 'Level-ups',
  death: 'Deaths',
  collection_log: 'Collection log',
};

const MARKER_SYMBOLS: Readonly<Record<string, string>> = {
  Drops: 'circle',
  'Level-ups': 'triangle',
  Deaths: 'diamond',
  'Collection log': 'rect',
};

/** A drop's dot grows with its value: 8px at 10K or less, 20px at 100M and up. */
export function dropSize(value: number | null): number {
  if (value === null || value <= 10_000) return 8;
  return Math.min(20, 8 + (Math.log10(value) - 4) * 3);
}

/** The index of the bucket `at` falls in (the last one at or before it); -1 before the first. */
export function bucketIndex(buckets: readonly { at: string }[], at: string): number {
  const t = Date.parse(at);
  let found = -1;
  for (let i = 0; i < buckets.length; i++) {
    if (Date.parse(buckets[i]!.at) <= t) found = i;
    else break;
  }
  return found;
}

/** The skills of a session that get their own colour (most XP first) and the rest as Other. */
export function timelineSkills(timeline: SessionTimeline): string[] {
  return timeline.session.xpBySkill.map((s) => s.skill).slice(0, 3);
}

/**
 * One session, bucket by bucket: XP per hour stacked by skill (three named skills and Other), the
 * idle stretches shaded, and markers on the baseline for drops (sized by value), level-ups, deaths
 * and collection log entries, each kind its own shape in the neutral ink (the colours belong to the
 * skills).
 */
export function timelineOption(
  timeline: SessionTimeline,
  timezone: string,
  theme: ChartTheme,
): ChartOption {
  const { buckets, markers } = timeline;
  const skills = timelineSkills(timeline);
  const color = activityColors(theme, skills);
  const perHour = HOUR_MS / METRICS_BUCKET_MS;
  const labels = buckets.map(
    (b) => formatInZone(b.at, timezone, { hour: '2-digit', minute: '2-digit' }) ?? '',
  );
  const stacks = [
    ...skills.map((skill) => ({
      name: skill,
      data: buckets.map((b) => (b.xp[skill] ?? 0) * perHour),
    })),
    {
      name: OTHER_ACTIVITY,
      data: buckets.map(
        (b) =>
          Object.entries(b.xp)
            .filter(([skill]) => !skills.includes(skill))
            .reduce((sum, [, xp]) => sum + xp, 0) * perHour,
      ),
    },
  ].filter((s) => s.data.some((v) => v > 0));

  // Idle stretches: consecutive idle buckets as one shaded area.
  const idle: [{ xAxis: number }, { xAxis: number }][] = [];
  for (let i = 0; i < buckets.length; i++) {
    if (buckets[i]!.active) continue;
    let j = i;
    while (j + 1 < buckets.length && !buckets[j + 1]!.active) j++;
    idle.push([{ xAxis: i }, { xAxis: j }]);
    i = j;
  }

  const markerGroups = new Map<string, { index: number; marker: TimelineMarker }[]>();
  for (const marker of markers) {
    const index = bucketIndex(buckets, marker.at);
    if (index < 0) continue;
    const label = MARKER_LABELS[marker.type];
    const list = markerGroups.get(label) ?? [];
    list.push({ index, marker });
    markerGroups.set(label, list);
  }
  const names = [...stacks.map((s) => s.name), ...markerGroups.keys()];

  const barData = stacks.map((s) =>
    barSeries(
      {
        name: s.name,
        data: s.data,
        itemStyle: { color: color(s.name), borderColor: theme.tooltipBackground, borderWidth: 1 },
      },
      { stack: 'xp', barCategoryGap: '10%' },
    ),
  );
  // The shading rides on the first series (a bar series when there is XP, else an empty line).
  const shade = {
    silent: true,
    itemStyle: { color: theme.grid, opacity: 0.45 },
    data: idle,
  };
  const series: NonNullable<ChartOption['series']> = [
    ...(barData.length > 0
      ? barData.map((s, i) => (i === 0 ? { ...s, markArea: shade } : s))
      : [
          lineSeries(
            theme,
            { name: 'XP', color: theme.series[0], data: buckets.map(() => 0), showSymbol: false },
            { lineStyle: { opacity: 0 }, markArea: shade, silent: true },
          ),
        ]),
    ...[...markerGroups.entries()].map(([label, list]) => ({
      type: 'scatter' as const,
      name: label,
      symbol: MARKER_SYMBOLS[label] ?? 'circle',
      z: 5,
      itemStyle: { color: theme.text, borderColor: theme.tooltipBackground, borderWidth: 2 },
      data: list.map(({ index, marker }) => ({
        value: [index, 0],
        symbolSize: label === 'Drops' ? dropSize(marker.value) : 9,
      })),
    })),
  ];

  return {
    ...baseOption(theme, { legend: names.length > 1 }),
    ...(names.length > 1
      ? {
          legend: {
            ...legend(theme, names, { width: 10, height: 10 }),
            itemStyle: { borderWidth: 0 },
          },
        }
      : {}),
    tooltip: axisTooltip(theme, 'shadow', (params) => {
      const i = firstParam(params)?.dataIndex ?? -1;
      const b = buckets[i];
      if (!b) return '';
      let html = tooltipTitle(`${labels[i]}${b.active ? '' : ' · idle'}`);
      for (const s of stacks) {
        const v = s.data[i] ?? 0;
        if (v > 0) html += tooltipRow(color(s.name), `${compact(v)} XP/h`, s.name, 'square');
      }
      for (const list of markerGroups.values()) {
        for (const { index, marker } of list) {
          if (index === i) html += `<div>${escapeHtml(marker.line)}</div>`;
        }
      }
      return html;
    }),
    xAxis: categoryAxis(theme, labels),
    yAxis: valueAxis(theme, { format: compact }),
    series,
  };
}

// --- Boss trends ---------------------------------------------------------------------------------

/** "Week of Oct 5" or "Oct 5": a boss period's label. */
export function periodLabel(start: string, step: 'day' | 'week'): string {
  return step === 'week' ? `Week of ${shortDay(start)}` : shortDay(start);
}

/** Kills per day or week, bars. */
export function bossKillsOption(
  periods: readonly BossPeriod[],
  step: 'day' | 'week',
  theme: ChartTheme,
): ChartOption {
  const color = theme.series[0];
  return {
    ...baseOption(theme),
    tooltip: axisTooltip(theme, 'shadow', (params) => {
      const p = periods[firstParam(params)?.dataIndex ?? -1];
      if (!p) return '';
      return (
        tooltipTitle(step === 'week' ? `Week of ${longDay(p.start)}` : longDay(p.start)) +
        tooltipRow(color, formatNumber(p.kills), p.kills === 1 ? 'kill' : 'kills', 'square') +
        (p.gp === null
          ? ''
          : `<div style="opacity:.7">${escapeHtml(`${compact(p.gp)} gp loot`)}</div>`)
      );
    }),
    xAxis: categoryAxis(
      theme,
      periods.map((p) => shortDay(p.start)),
    ),
    yAxis: valueAxis(theme, { minInterval: 1 }),
    series: [
      barSeries({
        name: 'Kills',
        data: periods.map((p) => p.kills),
        itemStyle: { color, borderRadius: [4, 4, 0, 0] },
      }),
    ],
  };
}

/** Cumulative loot against cumulative kills, one point per period with kills or loot. */
export function lootAgainstKills(periods: readonly BossPeriod[]): {
  start: string;
  kills: number;
  gp: number;
}[] {
  const out: { start: string; kills: number; gp: number }[] = [];
  let kills = 0;
  let gp = 0;
  for (const p of periods) {
    if (p.kills === 0 && !p.gp) continue;
    kills += p.kills;
    gp += p.gp ?? 0;
    out.push({ start: p.start, kills, gp });
  }
  return out;
}

/**
 * Whether a boss is paying off: loot so far (y) against kills so far (x). A steady slope is a steady
 * gp per kill; a step is a big drop.
 */
export function bossLootOption(
  periods: readonly BossPeriod[],
  step: 'day' | 'week',
  theme: ChartTheme,
): ChartOption {
  const points = lootAgainstKills(periods);
  const color = theme.series[0];
  return {
    ...baseOption(theme),
    tooltip: itemTooltip(theme, (params) => {
      const point = points[itemParam(params)?.dataIndex ?? -1];
      if (!point) return '';
      return (
        tooltipTitle(`Up to ${periodLabel(point.start, step)}`) +
        tooltipRow(color, `${compact(point.gp)} gp`, `in ${formatNumber(point.kills)} kills`)
      );
    }),
    xAxis: {
      type: 'value',
      min: 0,
      minInterval: 1,
      axisLine: { lineStyle: { color: theme.grid } },
      axisTick: { show: false },
      axisLabel: { color: theme.mutedText, fontFamily: theme.fontFamily, fontSize: 11 },
      splitLine: { show: false },
    },
    yAxis: valueAxis(theme, { format: compact }),
    series: [
      lineSeries(
        theme,
        {
          name: 'Loot',
          color,
          data: [[0, 0], ...points.map((p) => [p.kills, p.gp])],
          showSymbol: true,
        },
        { areaStyle: { color, opacity: 0.1 } },
      ),
    ],
  };
}

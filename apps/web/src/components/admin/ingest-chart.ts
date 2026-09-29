/**
 * The ingest health page's "payloads per minute" chart (handoff §12 Admin): one stacked column per
 * minute of getIngestHealth().perMinute, split into accepted (200) and everything else, built from
 * plain data and a resolved ChartTheme. Pure (type-only echarts imports), unit-tested in
 * ingest-chart.test.ts; the client component that draws it is payloads-chart.tsx.
 *
 * Marks follow the hub's chart rules (charts/options.ts): bars ≤ 24px with a 4px rounded top on the
 * topmost segment only, a 2px gap in the surface colour between stacked segments, one y-axis,
 * hairline grid, text in text colours, a legend for the two series and a tooltip per column that
 * lists every status.
 */
import { formatNumber } from '@hub/core';
import { escapeHtml, type ChartOption, type ChartTheme } from '@/components/charts/options';
import { httpStatusLabel, sortStatusKeys } from './admin-model';

/** One minute of getIngestHealth().perMinute, serialized for a client component. */
export interface MinutePoint {
  /** Start of the minute, ISO. */
  minute: string;
  total: number;
  byStatus: Record<string, number>;
}

export const PAYLOAD_SERIES = { accepted: 'Accepted (200)', other: 'Other statuses' } as const;

/** Accepted (status 200) and all other payloads of one minute. */
export function splitMinute(point: MinutePoint): { accepted: number; other: number } {
  const accepted = point.byStatus['200'] ?? 0;
  return { accepted, other: Math.max(0, point.total - accepted) };
}

const TIME = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });

function minuteLabel(iso: string): string {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? TIME.format(new Date(t)) : iso;
}

const ROUND_TOP = [4, 4, 0, 0];
const SQUARE = [0, 0, 0, 0];

/** The tooltip of one column: the minute, the total, and each status with its count. */
export function minuteTooltip(point: MinutePoint, colors: { accepted: string; other: string }) {
  const rows = sortStatusKeys(Object.keys(point.byStatus))
    .filter((key) => (point.byStatus[key] ?? 0) > 0)
    .map((key) => {
      const color = key === '200' ? colors.accepted : colors.other;
      return (
        `<div style="display:flex;align-items:center;gap:6px">` +
        `<span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${color}"></span>` +
        `<strong>${escapeHtml(formatNumber(point.byStatus[key] ?? 0))}</strong>` +
        `<span style="opacity:.7">${escapeHtml(key)} ${escapeHtml(httpStatusLabel(key))}</span></div>`
      );
    })
    .join('');
  return (
    `<div style="opacity:.7;margin-bottom:2px">${escapeHtml(minuteLabel(point.minute))} · ` +
    `${escapeHtml(formatNumber(point.total))} ${point.total === 1 ? 'payload' : 'payloads'}</div>` +
    rows
  );
}

/** Payloads per minute as two stacked bar series (see the file comment). */
export function payloadsPerMinuteOption(
  points: readonly MinutePoint[],
  theme: ChartTheme,
): ChartOption {
  const [acceptedColor, otherColor] = theme.series;
  const split = points.map(splitMinute);
  // Only the topmost non-empty segment of a column gets the rounded data end. Zero is '-' (no
  // mark): a zero-height bar would still draw its border as a sliver.
  const accepted = split.map((s) => ({
    value: s.accepted > 0 ? s.accepted : '-',
    itemStyle: { borderRadius: s.other > 0 ? SQUARE : ROUND_TOP },
  }));
  const other = split.map((s) => ({
    value: s.other > 0 ? s.other : '-',
    itemStyle: { borderRadius: ROUND_TOP },
  }));
  // The surface gap between stacked segments: a 1px border in the surface colour on each.
  const gap = { borderColor: theme.tooltipBackground, borderWidth: 1 };
  const axisLabel = { color: theme.mutedText, fontFamily: theme.fontFamily, fontSize: 11 };
  return {
    animation: false,
    textStyle: { fontFamily: theme.fontFamily },
    grid: {
      left: 4,
      right: 12,
      top: 36,
      bottom: 4,
      outerBoundsMode: 'same',
      outerBoundsContain: 'axisLabel',
    },
    legend: {
      top: 0,
      left: 0,
      icon: 'roundRect',
      itemWidth: 10,
      itemHeight: 10,
      textStyle: { color: theme.mutedText, fontFamily: theme.fontFamily, fontSize: 12 },
      data: [PAYLOAD_SERIES.accepted, PAYLOAD_SERIES.other],
    },
    tooltip: {
      confine: true,
      trigger: 'axis',
      axisPointer: { type: 'shadow', shadowStyle: { opacity: 0.08 } },
      backgroundColor: theme.tooltipBackground,
      borderColor: theme.tooltipBorder,
      borderWidth: 1,
      padding: [6, 10],
      textStyle: { color: theme.text, fontFamily: theme.fontFamily, fontSize: 12 },
      extraCssText: 'border-radius: 8px; box-shadow: 0 4px 12px rgb(0 0 0 / 0.12);',
      formatter: (params: unknown) => {
        const list: unknown[] = Array.isArray(params) ? params : [params];
        const index = (list[0] as { dataIndex?: number } | undefined)?.dataIndex ?? -1;
        const point = points[index];
        return point ? minuteTooltip(point, { accepted: acceptedColor, other: otherColor }) : '';
      },
    },
    xAxis: {
      type: 'category',
      data: points.map((p) => minuteLabel(p.minute)),
      axisLine: { lineStyle: { color: theme.grid } },
      axisTick: { show: false },
      axisLabel: { ...axisLabel, hideOverlap: true },
    },
    yAxis: {
      type: 'value',
      minInterval: 1,
      axisLabel,
      splitLine: { lineStyle: { color: theme.grid, width: 1 } },
    },
    series: [
      {
        type: 'bar',
        name: PAYLOAD_SERIES.accepted,
        stack: 'payloads',
        barMaxWidth: 24,
        data: accepted,
        color: acceptedColor,
        itemStyle: { color: acceptedColor, ...gap },
        emphasis: { itemStyle: { opacity: 0.85 } },
      },
      {
        type: 'bar',
        name: PAYLOAD_SERIES.other,
        stack: 'payloads',
        barMaxWidth: 24,
        data: other,
        color: otherColor,
        itemStyle: { color: otherColor, ...gap },
        emphasis: { itemStyle: { opacity: 0.85 } },
      },
    ],
  };
}

/** The chart's text alternative: totals over the window and the busiest minute. */
export function payloadsChartSummary(points: readonly MinutePoint[]): string {
  let total = 0;
  let other = 0;
  let peak: MinutePoint | null = null;
  for (const p of points) {
    total += p.total;
    other += splitMinute(p).other;
    if (!peak || p.total > peak.total) peak = p;
  }
  const period = points.length === 1 ? 'the last minute' : `the last ${points.length} minutes`;
  if (total === 0 || !peak) return `No payloads archived in ${period}.`;
  return (
    `${formatNumber(total)} ${total === 1 ? 'payload' : 'payloads'} in ${period}, ` +
    `${formatNumber(other)} not accepted; busiest minute ${minuteLabel(peak.minute)} ` +
    `with ${formatNumber(peak.total)}.`
  );
}

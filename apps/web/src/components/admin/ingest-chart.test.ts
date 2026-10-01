import { describe, expect, it } from 'vitest';
import { FALLBACK_THEME, type ChartTheme } from '@/components/charts/options';
import { httpStatusLabel } from './admin-model';
import {
  PAYLOAD_SERIES,
  minuteTooltip,
  payloadsChartSummary,
  payloadsPerMinuteOption,
  splitMinute,
  type MinutePoint,
} from './ingest-chart';

const points: MinutePoint[] = [
  { minute: '2026-09-29T10:00:00.000Z', total: 5, byStatus: { '200': 5 }, rejected: {} },
  {
    minute: '2026-09-29T10:01:00.000Z',
    total: 4,
    byStatus: { '200': 1, '503': 2, pending: 1 },
    rejected: {},
  },
  { minute: '2026-09-29T10:02:00.000Z', total: 0, byStatus: {}, rejected: {} },
  { minute: '2026-09-29T10:03:00.000Z', total: 2, byStatus: { '400': 2 }, rejected: {} },
  { minute: '2026-09-29T10:04:00.000Z', total: 3, byStatus: { '200': 3 }, rejected: { '401': 2 } },
  { minute: '2026-09-29T10:05:00.000Z', total: 0, byStatus: {}, rejected: { '429': 1 } },
];

const COLORS = { accepted: '#00f', other: '#f80', rejected: '#0a8' };

interface BarItem {
  value: number | '-';
  itemStyle: { borderRadius: number[] };
}

const ROUND = [4, 4, 0, 0];
const SQUARE = [0, 0, 0, 0];

describe('payloadsPerMinuteOption', () => {
  it('stacks accepted, other and rejected payloads, one column per minute', () => {
    expect(points.map(splitMinute)).toEqual([
      { accepted: 5, other: 0, rejected: 0 },
      { accepted: 1, other: 3, rejected: 0 },
      { accepted: 0, other: 0, rejected: 0 },
      { accepted: 0, other: 2, rejected: 0 },
      { accepted: 3, other: 0, rejected: 2 },
      { accepted: 0, other: 0, rejected: 1 },
    ]);
    const option = payloadsPerMinuteOption(points, FALLBACK_THEME);
    const series = option.series as { name: string; stack: string; data: BarItem[] }[];
    expect(series.map((s) => [s.name, s.stack])).toEqual([
      [PAYLOAD_SERIES.accepted, 'payloads'],
      [PAYLOAD_SERIES.other, 'payloads'],
      [PAYLOAD_SERIES.rejected, 'payloads'],
    ]);
    const [accepted, other, rejected] = series;
    expect(accepted?.data.map((d) => d.value)).toEqual([5, 1, '-', '-', 3, '-']);
    expect(other?.data.map((d) => d.value)).toEqual(['-', 3, '-', 2, '-', '-']);
    expect(rejected?.data.map((d) => d.value)).toEqual(['-', '-', '-', '-', 2, 1]);
    // Only the top segment of a column is rounded.
    expect(accepted?.data[0]?.itemStyle.borderRadius).toEqual(ROUND);
    expect(accepted?.data[1]?.itemStyle.borderRadius).toEqual(SQUARE);
    expect(other?.data[1]?.itemStyle.borderRadius).toEqual(ROUND);
    expect(accepted?.data[4]?.itemStyle.borderRadius).toEqual(SQUARE);
    expect(rejected?.data[4]?.itemStyle.borderRadius).toEqual(ROUND);
    expect((option.legend as { data: string[] }).data).toEqual([
      PAYLOAD_SERIES.accepted,
      PAYLOAD_SERIES.other,
      PAYLOAD_SERIES.rejected,
    ]);
    expect((option.xAxis as { data: string[] }).data).toHaveLength(points.length);
  });

  it('lists every status in the tooltip, escaped, rejected ones marked', () => {
    const html = minuteTooltip(
      {
        minute: '2026-09-29T10:01:00.000Z',
        total: 3,
        byStatus: { '503': 2, '<b>': 1 },
        rejected: { '401': 2 },
      },
      COLORS,
    );
    expect(html).toContain('5 payloads');
    expect(html).toContain('503 Unavailable');
    expect(html).toMatch(/background:#0a8.*401 [^<]*, not archived/);
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;b&gt;');
  });

  it('builds this whole option (pins what the shared chart helpers produce)', () => {
    const theme: ChartTheme = {
      dark: false,
      mutedText: '#111111',
      text: '#222222',
      grid: '#333333',
      tooltipBackground: '#444444',
      tooltipBorder: '#555555',
      fontFamily: 'Test Sans',
      series: ['#aa0000', '#00bb00', '#0000cc'],
    };
    const two = [points[1]!, points[4]!];
    const option = payloadsPerMinuteOption(two, theme);
    const time = (iso: string) =>
      new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(
        new Date(iso),
      );
    const bar = (name: string, color: string, data: BarItem[]) => ({
      type: 'bar',
      name,
      stack: 'payloads',
      barMaxWidth: 24,
      data,
      color,
      itemStyle: { color, borderColor: '#444444', borderWidth: 1 },
      emphasis: { itemStyle: { opacity: 0.85 } },
    });
    const item = (value: number | '-', borderRadius: number[]): BarItem => ({
      value,
      itemStyle: { borderRadius },
    });
    expect(option).toStrictEqual({
      animation: false,
      textStyle: { fontFamily: 'Test Sans' },
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
        textStyle: { color: '#111111', fontFamily: 'Test Sans', fontSize: 12 },
        data: ['Accepted (200)', 'Other statuses', 'Rejected, not archived'],
      },
      tooltip: {
        confine: true,
        trigger: 'axis',
        axisPointer: { type: 'shadow', shadowStyle: { opacity: 0.08 } },
        backgroundColor: '#444444',
        borderColor: '#555555',
        borderWidth: 1,
        padding: [6, 10],
        textStyle: { color: '#222222', fontFamily: 'Test Sans', fontSize: 12 },
        extraCssText: 'border-radius: 8px; box-shadow: 0 4px 12px rgb(0 0 0 / 0.12);',
        formatter: expect.any(Function),
      },
      xAxis: {
        type: 'category',
        data: [time(two[0]!.minute), time(two[1]!.minute)],
        axisLine: { lineStyle: { color: '#333333' } },
        axisTick: { show: false },
        axisLabel: { color: '#111111', fontFamily: 'Test Sans', fontSize: 11, hideOverlap: true },
      },
      yAxis: {
        type: 'value',
        minInterval: 1,
        axisLabel: { color: '#111111', fontFamily: 'Test Sans', fontSize: 11 },
        splitLine: { lineStyle: { color: '#333333', width: 1 } },
      },
      series: [
        bar('Accepted (200)', '#aa0000', [item(1, SQUARE), item(3, SQUARE)]),
        bar('Other statuses', '#00bb00', [item(3, ROUND), item('-', SQUARE)]),
        bar('Rejected, not archived', '#0000cc', [item('-', ROUND), item(2, ROUND)]),
      ],
    });

    const row = (color: string, count: string, label: string) =>
      `<div style="display:flex;align-items:center;gap:6px">` +
      `<span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${color}"></span>` +
      `<strong>${count}</strong><span style="opacity:.7">${label}</span></div>`;
    const formatter = (option.tooltip as { formatter: (p: unknown) => string }).formatter;
    expect(formatter([{ dataIndex: 1 }])).toBe(
      `<div style="opacity:.7;margin-bottom:2px">${time(two[1]!.minute)} · 5 payloads</div>` +
        row('#aa0000', '3', `200 ${httpStatusLabel('200')}`) +
        row('#0000cc', '2', `401 ${httpStatusLabel('401')}, not archived`),
    );
    expect(formatter({ dataIndex: 0 })).toBe(
      `<div style="opacity:.7;margin-bottom:2px">${time(two[0]!.minute)} · 4 payloads</div>` +
        row('#aa0000', '1', `200 ${httpStatusLabel('200')}`) +
        row('#00bb00', '2', `503 ${httpStatusLabel('503')}`) +
        row('#00bb00', '1', `pending ${httpStatusLabel('pending')}`),
    );
    expect(formatter([{ dataIndex: 7 }])).toBe('');
    expect(formatter([])).toBe('');
    expect(formatter([5])).toBe('');
  });

  it('summarizes the window for screen readers', () => {
    expect(payloadsChartSummary(points)).toMatch(
      /^17 payloads in the last 6 minutes, 8 not accepted \(3 rejected, not archived\); busiest minute .+ with 5\.$/,
    );
    expect(payloadsChartSummary(points.slice(0, 4))).toMatch(
      /^11 payloads in the last 4 minutes, 5 not accepted; busiest minute .+ with 5\.$/,
    );
    expect(
      payloadsChartSummary([{ minute: points[0]!.minute, total: 0, byStatus: {}, rejected: {} }]),
    ).toBe('No payloads in the last minute.');
  });
});

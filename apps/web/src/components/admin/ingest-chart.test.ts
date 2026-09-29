import { describe, expect, it } from 'vitest';
import { FALLBACK_THEME } from '@/components/charts/options';
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

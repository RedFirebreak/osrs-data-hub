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
  { minute: '2026-09-29T10:00:00.000Z', total: 5, byStatus: { '200': 5 } },
  { minute: '2026-09-29T10:01:00.000Z', total: 4, byStatus: { '200': 1, '503': 2, pending: 1 } },
  { minute: '2026-09-29T10:02:00.000Z', total: 0, byStatus: {} },
  { minute: '2026-09-29T10:03:00.000Z', total: 2, byStatus: { '400': 2 } },
];

interface BarItem {
  value: number | '-';
  itemStyle: { borderRadius: number[] };
}

describe('payloadsPerMinuteOption', () => {
  it('stacks accepted and other payloads, one column per minute', () => {
    expect(points.map(splitMinute)).toEqual([
      { accepted: 5, other: 0 },
      { accepted: 1, other: 3 },
      { accepted: 0, other: 0 },
      { accepted: 0, other: 2 },
    ]);
    const option = payloadsPerMinuteOption(points, FALLBACK_THEME);
    const series = option.series as { name: string; stack: string; data: BarItem[] }[];
    expect(series.map((s) => [s.name, s.stack])).toEqual([
      [PAYLOAD_SERIES.accepted, 'payloads'],
      [PAYLOAD_SERIES.other, 'payloads'],
    ]);
    const [accepted, other] = series;
    expect(accepted?.data.map((d) => d.value)).toEqual([5, 1, '-', '-']);
    expect(other?.data.map((d) => d.value)).toEqual(['-', 3, '-', 2]);
    // Only the top segment of a column is rounded.
    expect(accepted?.data[0]?.itemStyle.borderRadius).toEqual([4, 4, 0, 0]);
    expect(accepted?.data[1]?.itemStyle.borderRadius).toEqual([0, 0, 0, 0]);
    expect(other?.data[1]?.itemStyle.borderRadius).toEqual([4, 4, 0, 0]);
    expect((option.xAxis as { data: string[] }).data).toHaveLength(points.length);
  });

  it('lists every status in the tooltip, escaped', () => {
    const html = minuteTooltip(
      { minute: '2026-09-29T10:01:00.000Z', total: 3, byStatus: { '503': 2, '<b>': 1 } },
      { accepted: '#00f', other: '#f80' },
    );
    expect(html).toContain('3 payloads');
    expect(html).toContain('503 Unavailable');
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;b&gt;');
  });

  it('summarizes the window for screen readers', () => {
    expect(payloadsChartSummary(points)).toMatch(
      /^11 payloads in the last 4 minutes, 5 not accepted; busiest minute .+ with 5\.$/,
    );
    expect(payloadsChartSummary([{ minute: points[0]!.minute, total: 0, byStatus: {} }])).toBe(
      'No payloads archived in the last minute.',
    );
  });
});

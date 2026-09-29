'use client';
/**
 * Payloads per minute on the ingest health page: the stacked column chart of ingest-chart.ts drawn
 * with the shared ECharts wrapper (loaded lazily, client only). The text alternative the chart
 * element announces (role="img", payloadsChartSummary) is built here in the browser, like the axis
 * labels: built by the server page, its "busiest minute" was in the server's time zone.
 */
import { useCallback, useMemo } from 'react';
import { LazyEChart } from '@/components/charts/lazy-echart';
import type { ChartTheme } from '@/components/charts/options';
import { payloadsChartSummary, payloadsPerMinuteOption, type MinutePoint } from './ingest-chart';

export interface PayloadsChartProps {
  points: MinutePoint[];
}

export function PayloadsChart({ points }: PayloadsChartProps) {
  const option = useCallback(
    (theme: ChartTheme) => payloadsPerMinuteOption(points, theme),
    [points],
  );
  // Only rendered in the browser: LazyEChart is ssr: false, so the server HTML has no label.
  const summary = useMemo(() => payloadsChartSummary(points), [points]);
  // Default size (h-64), the same as LazyEChart's loading skeleton: no jump when echarts arrives.
  return <LazyEChart option={option} label={summary} />;
}

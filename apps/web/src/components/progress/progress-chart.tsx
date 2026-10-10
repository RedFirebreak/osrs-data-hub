'use client';
/**
 * The chart of a Progress view: the measure adding up through the range (chart-options.ts), with
 * its numbers as a table under it. When the range or measure changes the line moves to the new data
 * instead of being redrawn, and a second change before it settles redirects it; it dims while the
 * new view is on its way. Drawn by the lazy EChart.
 */
import type { MetricsMeasure } from '@hub/core';
import { useCallback, useMemo } from 'react';
import { ChartDataTable } from '@/components/charts/data-table';
import { LazyEChart } from '@/components/charts/lazy-echart';
import { MOMENT_OPTIONS, type ChartTheme } from '@/components/charts/options';
import { formatAmount } from '@/components/metrics/format';
import { formatInZone } from '@/lib/dates';
import { useReducedMotion } from '@/lib/use-reduced-motion';
import { progressOption } from './chart-options';
import { useProgressQuery } from './progress-nav';

export interface ProgressChartProps {
  /** `[ms since the range's start, running total]` (a PeriodComparison's current line). */
  points: readonly (readonly [number, number])[];
  /** The range (ISO). */
  from: string;
  to: string;
  measure: MetricsMeasure;
  /** The skill the XP is of; null for all skills and for the other measures. */
  skill: string | null;
  /** What is counted, for the tooltip and the table ("Firemaking XP", "Loot"). */
  name: string;
  /** What the chart shows, for screen readers. */
  label: string;
  timezone: string;
}

export function ProgressChart({
  points,
  from,
  to,
  measure,
  skill,
  name,
  label,
  timezone,
}: ProgressChartProps) {
  const { pending } = useProgressQuery();
  const animate = !useReducedMotion();
  const option = useCallback(
    (theme: ChartTheme) =>
      progressOption({ points, from, to, measure, skill, name, timezone, animate }, theme),
    [points, from, to, measure, skill, name, timezone, animate],
  );
  const rows = useMemo(() => {
    const start = Date.parse(from);
    return points
      .map(([offset, value]) => [
        formatInZone(new Date(start + offset), timezone, MOMENT_OPTIONS) ?? '',
        formatAmount(measure, value),
      ])
      .reverse();
  }, [points, from, measure, timezone]);
  return (
    <div>
      <LazyEChart option={option} label={label} busy={pending} morph className="h-72" />
      <ChartDataTable columns={['Up to', name]} rows={rows} />
    </div>
  );
}

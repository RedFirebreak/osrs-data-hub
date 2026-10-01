'use client';
/**
 * Carried wealth per day (inventory + equipment, GE value): the day's end value and its high, drawn
 * by the lazy EChart, with the numbers in a table below (newest day first) for screen readers.
 */
import { formatGp } from '@hub/core';
import { useCallback } from 'react';
import { ChartWithTable } from './chart-with-table';
import { WEALTH_SERIES, wealthOption, type ChartTheme, type WealthPoint } from './options';

export interface WealthChartProps {
  days: readonly WealthPoint[];
  className?: string;
}

export function WealthChart({ days, className }: WealthChartProps) {
  const option = useCallback((theme: ChartTheme) => wealthOption(days, theme), [days]);
  const newest = days.at(-1);
  return (
    <ChartWithTable
      className={className}
      option={option}
      label={`Carried wealth per day over ${days.length} days${
        newest ? `, ${formatGp(newest.lastValue)} gp at the end of ${newest.day}` : ''
      }`}
      columns={['Day (UTC)', WEALTH_SERIES.last, WEALTH_SERIES.max]}
      rows={[...days].reverse().map((d) => ({
        day: d.day,
        values: [formatGp(d.lastValue), formatGp(d.maxValue)],
      }))}
    />
  );
}

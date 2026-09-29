'use client';
/**
 * Carried wealth per day (inventory + equipment, GE value): the day's end value and its high, drawn
 * by the lazy EChart, with the numbers in a table below for screen readers.
 */
import { formatGp } from '@hub/core';
import { useCallback } from 'react';
import { LazyEChart } from './lazy-echart';
import { WEALTH_SERIES, wealthOption, type ChartTheme, type WealthPoint } from './options';

export interface WealthChartProps {
  days: readonly WealthPoint[];
  className?: string;
}

export function WealthChart({ days, className }: WealthChartProps) {
  const option = useCallback((theme: ChartTheme) => wealthOption(days, theme), [days]);
  const newest = days.at(-1);
  return (
    <div className={className}>
      <LazyEChart
        option={option}
        label={`Carried wealth per day over ${days.length} days${
          newest ? `, ${formatGp(newest.lastValue)} gp at the end of ${newest.day}` : ''
        }`}
      />
      <details className="mt-2 text-xs text-muted-foreground">
        <summary className="cursor-pointer select-none hover:text-foreground">Show as table</summary>
        <table className="mt-2 w-full text-left tabular-nums">
          <thead>
            <tr>
              <th scope="col" className="py-1 font-medium">
                Day (UTC)
              </th>
              <th scope="col" className="py-1 text-right font-medium">
                {WEALTH_SERIES.last}
              </th>
              <th scope="col" className="py-1 text-right font-medium">
                {WEALTH_SERIES.max}
              </th>
            </tr>
          </thead>
          <tbody>
            {[...days].reverse().map((d) => (
              <tr key={d.day} className="border-t">
                <td className="py-1">
                  <time dateTime={d.day}>{d.day}</time>
                </td>
                <td className="py-1 text-right">{formatGp(d.lastValue)}</td>
                <td className="py-1 text-right">{formatGp(d.maxValue)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}

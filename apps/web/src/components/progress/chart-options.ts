/**
 * The Progress line: one measure adding up through a range, as a single line with a light wash under
 * it, in the colour of what it counts (a skill's own colour, the text colour for all XP, the chart
 * palette for loot, kills and play time). Pure; the client wrapper is progress-chart.tsx.
 *
 * Unlike the hub's other charts this one animates: its option keeps its shape while the range and
 * measure change, so ECharts can move the line from where it is (EChart `morph`). `animate` is off
 * for people who asked for less motion.
 */
import type { MetricsMeasure } from '@hub/core';
import {
  MOMENT_OPTIONS,
  axisTooltip,
  baseOption,
  firstParam,
  lineSeries,
  timeAxis,
  tooltipRow,
  tooltipTitle,
  valueAxis,
  type ChartOption,
  type ChartTheme,
} from '@/components/charts/options';
import { formatAmount, formatAxisAmount } from '@/components/metrics/format';
import { formatInZone } from '@/lib/dates';
import { skillColor } from '@/lib/skill-colors';

export interface ProgressChartInput {
  /** `[ms since the range's start, running total]`, in time order (a PeriodComparison's line). */
  points: readonly (readonly [number, number])[];
  /** The range (ISO). */
  from: string;
  to: string;
  measure: MetricsMeasure;
  /** The skill the XP is of; null for every skill together and for the other measures. */
  skill: string | null;
  /** In the tooltip, after the amount ("Firemaking", "Loot"). */
  name: string;
  timezone: string;
  animate: boolean;
}

/** The line's colour: the skill's own, the text colour for all XP, the palette for the rest. */
export function progressColor(
  measure: MetricsMeasure,
  skill: string | null,
  theme: ChartTheme,
): string {
  if (measure === 'xp') return skill === null ? theme.text : skillColor(skill, theme.dark);
  const [loot, kills, playTime] = theme.series;
  return { gp: loot, kills, active: playTime }[measure];
}

/** How long the line takes to settle on new data, in ms. */
export const MORPH_MS = 420;

export function progressOption(input: ProgressChartInput, theme: ChartTheme): ChartOption {
  const from = new Date(input.from);
  const to = new Date(input.to);
  const color = progressColor(input.measure, input.skill, theme);
  const data = input.points.map(([offset, value]) => [from.getTime() + offset, value]);
  return {
    ...baseOption(theme),
    animation: input.animate,
    animationDuration: MORPH_MS,
    animationDurationUpdate: MORPH_MS,
    animationEasing: 'cubicOut',
    animationEasingUpdate: 'cubicOut',
    tooltip: axisTooltip(theme, 'line', (params) => {
      const p = firstParam(params);
      const value = Array.isArray(p?.value) ? (p.value as [number, number]) : null;
      if (!value) return '';
      return (
        tooltipTitle(formatInZone(new Date(value[0]), input.timezone, MOMENT_OPTIONS) ?? '') +
        tooltipRow(color, formatAmount(input.measure, value[1]), input.name)
      );
    }),
    xAxis: timeAxis(theme, from, to),
    // Amounts are whole numbers: without this a flat range labels its axis 0, 0, 0, 1, 1, 1.
    yAxis: valueAxis(theme, {
      minInterval: 1,
      format: (v) => formatAxisAmount(input.measure, v),
    }),
    series: [
      lineSeries(
        theme,
        { name: input.name, color, data, showSymbol: false },
        { id: 'progress', areaStyle: { color, opacity: 0.12 }, lineStyle: { width: 2.5, color } },
      ),
    ],
  };
}

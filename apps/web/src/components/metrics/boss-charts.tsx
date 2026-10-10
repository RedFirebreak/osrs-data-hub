'use client';
/**
 * The boss page's trends (D-108): kills per day or week, and loot so far against kills so far (is
 * the boss paying off). Each with its table.
 */
import { formatGp, formatNumber } from '@hub/core';
import type { BossPeriod } from '@hub/server';
import { useCallback } from 'react';
import type { ChartTheme } from '@/components/charts/options';
import { bossKillsOption, bossLootOption, lootAgainstKills, periodLabel } from './chart-options';
import { MetricsChart } from './metrics-chart';

export function BossKillsChart({
  periods,
  step,
  activity,
}: {
  periods: readonly BossPeriod[];
  step: 'day' | 'week';
  activity: string;
}) {
  const option = useCallback(
    (theme: ChartTheme) => bossKillsOption(periods, step, theme),
    [periods, step],
  );
  const total = periods.reduce((s, p) => s + p.kills, 0);
  return (
    <MetricsChart
      option={option}
      label={`${activity} kills per ${step}, ${formatNumber(total)} in total`}
      columns={[
        step === 'week' ? 'Week of' : 'Day',
        'Kills',
        ...(periods[0]?.gp === null ? [] : ['Loot']),
      ]}
      rows={periods
        .filter((p) => p.kills > 0 || (p.gp ?? 0) > 0)
        .map((p) => [
          periodLabel(p.start, step),
          formatNumber(p.kills),
          ...(p.gp === null ? [] : [`${formatGp(p.gp)} gp`]),
        ])
        .reverse()}
      note="Kills are read from the hiscores after each session, so they land on the day of the reading."
    />
  );
}

export function BossLootChart({
  periods,
  step,
  activity,
}: {
  periods: readonly BossPeriod[];
  step: 'day' | 'week';
  activity: string;
}) {
  const option = useCallback(
    (theme: ChartTheme) => bossLootOption(periods, step, theme),
    [periods, step],
  );
  const points = lootAgainstKills(periods);
  return (
    <MetricsChart
      option={option}
      label={`${activity} loot so far against kills so far`}
      columns={['Up to', 'Kills', 'Loot', 'Per kill']}
      rows={points
        .map((p) => [
          periodLabel(p.start, step),
          formatNumber(p.kills),
          `${formatGp(p.gp)} gp`,
          p.kills > 0 ? `${formatGp(p.gp / p.kills)} gp` : '—',
        ])
        .reverse()}
      note="A steady slope is a steady gp per kill; a jump is a big drop."
    />
  );
}

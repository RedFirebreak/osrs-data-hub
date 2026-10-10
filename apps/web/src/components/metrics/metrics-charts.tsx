'use client';
/**
 * The Metrics tab's charts (D-106), each a MetricsChart with its table: the period comparison (a
 * brush on it narrows the range), the effective-hours heatmap (a cell lists the sessions in it), the
 * sessions scatter (a dot opens that session's timeline), the rate through a session, where the time
 * goes, and one session's timeline. Options come from chart-options.ts; filters from the URL
 * (metrics-nav.tsx).
 */
import {
  LocalClockCache,
  METRICS_BUCKET_MS,
  formatNumber,
  heatValue,
  type HeatCell,
  type MetricsMeasure,
  type PeriodComparison,
  type RateStep,
  type TimeByActivity,
} from '@hub/core';
import type { SessionCard, SessionTimeline } from '@hub/server';
import type { Route } from 'next';
import Link from 'next/link';
import { useCallback, useMemo, useState } from 'react';
import type { ChartTheme } from '@/components/charts/options';
import { MOMENT_OPTIONS, compact, longDay } from '@/components/charts/options';
import { Button } from '@/components/ui/button';
import { formatInZone } from '@/lib/dates';
import {
  COMPARISON_SERIES,
  MARKER_LABELS,
  brushedSpan,
  comparisonOption,
  foldTimeByActivity,
  heatLabel,
  heatmapOption,
  itemParam,
  rateThroughOption,
  scatterOption,
  sessionRate,
  stepLabel,
  timeByActivityOption,
  timelineOption,
  timelineSkills,
} from './chart-options';
import { MEASURE_LABELS, WEEKDAYS, formatAmount, formatHour, formatMs, formatRate } from './format';
import { MetricsChart } from './metrics-chart';
import { useMetricsQuery } from './metrics-nav';

// --- Period comparison ---------------------------------------------------------------------------

export function ComparisonChart({
  comparison,
  measure,
  from,
  to,
  timezone,
}: {
  comparison: PeriodComparison;
  measure: MetricsMeasure;
  from: string;
  to: string;
  timezone: string;
}) {
  const { set } = useMetricsQuery();
  const option = useCallback(
    (theme: ChartTheme) => comparisonOption({ comparison, measure, from, to, timezone }, theme),
    [comparison, measure, from, to, timezone],
  );
  const onEvents = useMemo(
    () => ({
      brushEnd: (params: unknown) => {
        const span = brushedSpan(params);
        if (!span) return;
        set({
          range: 'custom',
          from: new Date(span.from).toISOString(),
          to: new Date(span.to).toISOString(),
          session: null,
        });
      },
    }),
    [set],
  );
  const start = Date.parse(from);
  const previous = comparison.previous;
  const rows = comparison.current.map(([offset, value], i) => [
    formatInZone(new Date(start + offset), timezone, MOMENT_OPTIONS) ?? '',
    formatAmount(measure, value),
    ...(previous ? [previous[i] ? formatAmount(measure, previous[i][1]) : '—'] : []),
  ]);
  const total = comparison.current.at(-1)?.[1] ?? 0;
  const before = previous?.at(-1)?.[1] ?? null;
  return (
    <MetricsChart
      option={option}
      label={`${MEASURE_LABELS[measure]} through the range, ${formatAmount(measure, total)} in total${
        before === null ? '' : `, against ${formatAmount(measure, before)} the period before`
      }`}
      columns={[
        'Up to',
        COMPARISON_SERIES.current,
        ...(previous ? [COMPARISON_SERIES.previous] : []),
      ]}
      rows={rows.reverse()}
      onEvents={onEvents}
      brush
      note="Drag across the chart to look at just that stretch."
    />
  );
}

// --- Heatmap -------------------------------------------------------------------------------------

/** The sessions with online time in one weekday and hour (the viewer's time zone). */
export function sessionsInCell(
  sessions: readonly SessionCard[],
  cell: { weekday: number; hour: number },
  timezone: string,
): SessionCard[] {
  const clock = new LocalClockCache(timezone);
  return sessions.filter((s) => {
    const end = Date.parse(s.end);
    for (let t = Date.parse(s.start); t < end; t += METRICS_BUCKET_MS) {
      const local = clock.at(t);
      if (local.weekday === cell.weekday && local.hour === cell.hour) return true;
    }
    return false;
  });
}

export function HeatmapChart({
  cells,
  sessions,
  measure,
  timezone,
}: {
  cells: readonly HeatCell[];
  sessions: readonly SessionCard[];
  measure: MetricsMeasure;
  timezone: string;
}) {
  const { href } = useMetricsQuery();
  const [picked, setPicked] = useState<{ weekday: number; hour: number } | null>(null);
  const option = useCallback(
    (theme: ChartTheme) => heatmapOption(cells, measure, theme),
    [cells, measure],
  );
  const onEvents = useMemo(
    () => ({
      click: (params: unknown) => {
        const cell = cells[itemParam(params)?.dataIndex ?? -1];
        if (cell && cell.onlineMs > 0) setPicked({ weekday: cell.weekday, hour: cell.hour });
      },
    }),
    [cells],
  );
  const inCell = picked ? sessionsInCell(sessions, picked, timezone) : [];
  const rows = cells
    .filter((c) => c.onlineMs > 0)
    .map((c) => [
      `${WEEKDAYS[c.weekday]} ${formatHour(c.hour)}`,
      formatMs(c.onlineMs),
      formatMs(c.activeMs),
      ...(measure === 'active' ? [] : [formatRate(measure, heatValue(c, { measure }))]),
    ]);
  return (
    <div className="flex flex-col gap-3">
      <MetricsChart
        option={option}
        label={`When the play is effective: ${heatLabel(measure)} by weekday and hour`}
        columns={[
          'Weekday and hour',
          'Online',
          'Active',
          ...(measure === 'active' ? [] : [`${MEASURE_LABELS[measure]} per active hour`]),
        ]}
        rows={rows}
        className="h-72"
        onEvents={onEvents}
        note="Active means XP or a drop in a 5-minute stretch, so a short bank trip in a busy stretch still counts. Click a square for its sessions."
      />
      {picked && (
        <div className="rounded-lg border p-3 text-sm" aria-live="polite">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h3 className="font-medium">
              {WEEKDAYS[picked.weekday]} {formatHour(picked.hour)}–{formatHour(picked.hour + 1)}:{' '}
              {inCell.length} {inCell.length === 1 ? 'session' : 'sessions'}
            </h3>
            <Button variant="ghost" size="xs" onClick={() => setPicked(null)}>
              Close
            </Button>
          </div>
          <ul className="flex flex-col divide-y">
            {inCell.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                <Link
                  href={`${href({ session: s.id })}#timeline` as Route}
                  className="hover:underline"
                >
                  {formatInZone(s.start, timezone, MOMENT_OPTIONS)}
                </Link>
                <span className="text-muted-foreground tabular-nums">
                  {formatMs(s.onlineMs)} · {s.main?.name ?? 'no main activity'}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// --- Sessions scatter ----------------------------------------------------------------------------

export function SessionsScatter({
  sessions,
  measure,
  activities,
  timezone,
}: {
  sessions: readonly SessionCard[];
  measure: MetricsMeasure;
  activities: readonly string[];
  timezone: string;
}) {
  const { set } = useMetricsQuery();
  const option = useCallback(
    (theme: ChartTheme) => scatterOption({ sessions, measure, activities, timezone }, theme),
    [sessions, measure, activities, timezone],
  );
  const onEvents = useMemo(
    () => ({
      click: (params: unknown) => {
        const id = (itemParam(params)?.data as { id?: string } | undefined)?.id;
        if (id) set({ session: id }, { anchor: 'timeline' });
      },
    }),
    [set],
  );
  return (
    <MetricsChart
      option={option}
      label={`${sessions.length} sessions by length and ${MEASURE_LABELS[measure]} rate`}
      columns={['Session', 'Online', 'Rate', 'Main activity']}
      rows={sessions.map((s) => [
        formatInZone(s.start, timezone, MOMENT_OPTIONS) ?? '',
        formatMs(s.onlineMs),
        formatRate(measure, sessionRate(s, measure)),
        s.main?.name ?? '—',
      ])}
      onEvents={onEvents}
      note="One dot per session. Click one for its timeline."
    />
  );
}

// --- Rate through a session ----------------------------------------------------------------------

export function RateThroughChart({
  steps,
  measure,
}: {
  steps: readonly RateStep[];
  measure: MetricsMeasure;
}) {
  const option = useCallback(
    (theme: ChartTheme) => rateThroughOption(steps, measure, theme),
    [steps, measure],
  );
  return (
    <MetricsChart
      option={option}
      label={`Median ${MEASURE_LABELS[measure]} rate by time into the session, with the middle half`}
      columns={['Into the session', 'Median', 'Middle half', 'Sessions']}
      rows={steps.map((s) => [
        stepLabel(s),
        formatRate(measure, s.median),
        `${formatRate(measure, s.p25)} to ${formatRate(measure, s.p75)}`,
        formatNumber(s.sessions),
      ])}
      note="Each step counts the sessions that lasted through all of it; the band is the middle half of them."
    />
  );
}

// --- Where the time goes -------------------------------------------------------------------------

export function TimeByActivityChart({
  data,
  activities,
}: {
  data: TimeByActivity;
  activities: readonly string[];
}) {
  const option = useCallback(
    (theme: ChartTheme) => timeByActivityOption(data, activities, theme),
    [data, activities],
  );
  const series = foldTimeByActivity(data, activities);
  return (
    <MetricsChart
      option={option}
      label={`Active time per day by activity: ${series.map((s) => s.name).join(', ')}`}
      columns={['Day', ...series.map((s) => s.name)]}
      rows={data.days
        .map((day, i) => [longDay(day), ...series.map((s) => formatMs(s.ms[i] ?? 0))])
        .reverse()}
      note="A 5-minute stretch goes to the source of its best drop, else to the skill with the most XP in it."
    />
  );
}

// --- Session timeline ----------------------------------------------------------------------------

export function SessionTimelineChart({
  timeline,
  timezone,
}: {
  timeline: SessionTimeline;
  timezone: string;
}) {
  const option = useCallback(
    (theme: ChartTheme) => timelineOption(timeline, timezone, theme),
    [timeline, timezone],
  );
  const skills = timelineSkills(timeline);
  const time = (iso: string) => formatInZone(iso, timezone, { hour: '2-digit', minute: '2-digit' });
  const rows = timeline.buckets.map((b) => [
    time(b.at) ?? '',
    b.active ? 'active' : 'idle',
    ...skills.map((s) => formatNumber(b.xp[s] ?? 0)),
    compact(b.gp),
  ]);
  return (
    <div className="flex flex-col gap-3">
      <MetricsChart
        option={option}
        label={`The session bucket by bucket: XP per hour by skill, idle stretches shaded, ${timeline.markers.length} events marked`}
        columns={['Time', 'State', ...skills.map((s) => `${s} XP`), 'Loot (gp)']}
        rows={rows}
        className="h-72"
        note="Shaded: idle (no XP and no drop). Shapes on the baseline: drops (larger is worth more), level-ups, deaths and collection log entries."
      />
      {timeline.markers.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-xs text-muted-foreground select-none hover:text-foreground">
            {timeline.markers.length} events in this session
          </summary>
          <ol className="mt-2 flex flex-col divide-y">
            {timeline.markers.map((m, i) => (
              <li key={`${m.at}-${i}`} className="flex gap-3 py-1.5">
                <time dateTime={m.at} className="w-12 shrink-0 text-muted-foreground tabular-nums">
                  {time(m.at)}
                </time>
                <span className="sr-only">{MARKER_LABELS[m.type]}: </span>
                <span className="min-w-0">{m.line}</span>
              </li>
            ))}
          </ol>
        </details>
      )}
    </div>
  );
}

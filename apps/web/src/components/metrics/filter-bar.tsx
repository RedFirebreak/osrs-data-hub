'use client';
/**
 * The Metrics filter bar (D-106), one row above the charts: the range (a preset or two days), the
 * overlay of the period before, the measure (XP of some skills, loot, kills of some bosses, active
 * time) and, when the viewer may see sessions, the session filters (shortest length, weekdays, time
 * of day, main activity). Every change replaces the URL (metrics-nav.tsx). On a phone the session
 * filters fold away behind "Session filters".
 */
import {
  METRICS_RANGES,
  METRICS_RANGE_LABELS,
  hasSessionFilter,
  localClock,
  type MetricsMeasure,
} from '@hub/core';
import { ChevronDownIcon, XIcon } from 'lucide-react';
import { useId, useState } from 'react';
import { NativeSelect } from '@/components/common/native-select';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';
import { formatInZone } from '@/lib/dates';
import { MOMENT_OPTIONS } from '@/components/charts/options';
import { cn } from '@/lib/utils';
import { MEASURE_LABELS, WEEKDAYS, formatHour } from './format';
import { useMetricsQuery } from './metrics-nav';

const MEASURES: readonly MetricsMeasure[] = ['xp', 'gp', 'kills', 'active'];

/** Shortest-session choices, in minutes. */
const MIN_LENGTHS = [15, 30, 60, 120] as const;

/** Times of day a session may start in (local hours, [from, to), wrapping). */
export const TIMES_OF_DAY = [
  { label: 'Morning', from: 6, to: 12 },
  { label: 'Afternoon', from: 12, to: 18 },
  { label: 'Evening', from: 18, to: 0 },
  { label: 'Night', from: 0, to: 6 },
] as const;

export interface FilterBarProps {
  /** The measures the viewer may read (the rest are offered disabled, with why). */
  measures: Readonly<Record<MetricsMeasure, boolean>>;
  /** Whether the viewer may see sessions (`activity` and `stats`). */
  sessions: boolean;
  options: { skills: readonly string[]; bosses: readonly string[]; activities: readonly string[] };
  /** The resolved range (ISO), for the custom range's two days. */
  range: { from: string; to: string };
  timezone: string;
  /** The chosen session's start, for its chip; null when none is chosen. */
  sessionStart: string | null;
  /** Only the range (a boss page): no comparison, measure or session filters. */
  rangeOnly?: boolean;
}

export function FilterBar({
  measures,
  sessions,
  options,
  range,
  timezone,
  sessionStart,
  rangeOnly = false,
}: FilterBarProps) {
  const { query, set, pending } = useMetricsQuery();
  const id = useId();
  const [custom, setCustom] = useState(query.range === 'custom');
  const firstDay = localClock(Date.parse(range.from), timezone).day;
  const lastDay = localClock(Date.parse(range.to) - 1, timezone).day;
  const [days, setDays] = useState({ from: firstDay, to: lastDay });
  const filtered = hasSessionFilter(query);

  return (
    <div
      role="group"
      aria-label="Filters"
      aria-busy={pending || undefined}
      className="flex flex-col gap-3 rounded-xl border bg-card p-3 text-sm"
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div role="radiogroup" aria-label="Range" className="flex flex-wrap gap-1">
          {METRICS_RANGES.map((r) => {
            const checked = r === 'custom' ? custom : !custom && query.range === r;
            return (
              <Button
                key={r}
                role="radio"
                aria-checked={checked}
                variant={checked ? 'secondary' : 'ghost'}
                size="sm"
                className={cn(checked && 'shadow-[inset_0_-2px_0_var(--foreground)]')}
                onClick={() => {
                  if (r === 'custom') return setCustom(true);
                  setCustom(false);
                  set({ range: r, from: null, to: null, session: null });
                }}
              >
                {METRICS_RANGE_LABELS[r]}
              </Button>
            );
          })}
        </div>
        {custom && (
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (days.from && days.to && days.from <= days.to) {
                set({ range: 'custom', from: days.from, to: days.to, session: null });
              }
            }}
          >
            <label htmlFor={`${id}-from`} className="text-muted-foreground">
              From
            </label>
            <Input
              id={`${id}-from`}
              type="date"
              value={days.from}
              max={days.to}
              onChange={(e) => setDays((d) => ({ ...d, from: e.target.value }))}
              className="h-7 w-auto"
            />
            <label htmlFor={`${id}-to`} className="text-muted-foreground">
              to
            </label>
            <Input
              id={`${id}-to`}
              type="date"
              value={days.to}
              min={days.from}
              onChange={(e) => setDays((d) => ({ ...d, to: e.target.value }))}
              className="h-7 w-auto"
            />
            <Button type="submit" size="sm" variant="outline">
              Show
            </Button>
          </form>
        )}
        {!rangeOnly && (
          <label className="flex items-center gap-2">
            <Switch
              checked={query.compare}
              onCheckedChange={(compare) => set({ compare })}
              disabled={query.measure === 'active'}
              size="sm"
            />
            <span className={cn(query.measure === 'active' && 'text-muted-foreground')}>
              Compare with the period before
            </span>
          </label>
        )}
      </div>

      {!rangeOnly && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="flex items-center gap-2">
            <label htmlFor={`${id}-measure`} className="text-muted-foreground">
              Show
            </label>
            <NativeSelect
              id={`${id}-measure`}
              value={query.measure}
              onChange={(e) =>
                set({
                  measure: e.target.value as MetricsMeasure,
                  ...(e.target.value === 'active' ? { compare: false } : {}),
                })
              }
              className="h-7 w-auto"
            >
              {MEASURES.map((m) => (
                <option key={m} value={m} disabled={!measures[m]}>
                  {MEASURE_LABELS[m]}
                  {measures[m] ? '' : ' (not shared)'}
                </option>
              ))}
            </NativeSelect>
          </div>
          {query.measure === 'xp' && options.skills.length > 0 && (
            <NamePicker
              label="Skills"
              all="All skills"
              names={options.skills}
              value={query.skills}
              onChange={(skills) => set({ skills })}
            />
          )}
          {query.measure === 'kills' && options.bosses.length > 0 && (
            <NamePicker
              label="Bosses"
              all="All bosses"
              names={options.bosses}
              value={query.bosses}
              onChange={(bosses) => set({ bosses })}
            />
          )}
          {sessionStart && (
            <span className="inline-flex items-center gap-1 rounded-full bg-muted py-0.5 pr-1 pl-2.5">
              Session of {formatInZone(sessionStart, timezone, MOMENT_OPTIONS)}
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Close the session"
                onClick={() => set({ session: null })}
              >
                <XIcon />
              </Button>
            </span>
          )}
        </div>
      )}

      {sessions && !rangeOnly && (
        <details className="group md:contents" open={filtered || undefined}>
          <summary className="flex cursor-pointer items-center gap-1 text-muted-foreground select-none md:hidden">
            <ChevronDownIcon className="size-4 transition-transform group-open:rotate-180" />
            Session filters{filtered ? ' (on)' : ''}
          </summary>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 md:mt-0">
            <span className="hidden text-muted-foreground md:inline">Sessions:</span>
            <div className="flex items-center gap-2">
              <label htmlFor={`${id}-min`} className="text-muted-foreground">
                At least
              </label>
              <NativeSelect
                id={`${id}-min`}
                value={query.minMinutes ?? ''}
                onChange={(e) =>
                  set({ minMinutes: e.target.value === '' ? null : Number(e.target.value) })
                }
                className="h-7 w-auto"
              >
                <option value="">any length</option>
                {MIN_LENGTHS.map((m) => (
                  <option key={m} value={m}>
                    {m < 60 ? `${m} min` : `${m / 60} h`}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div role="group" aria-label="Weekdays" className="flex gap-0.5">
              {WEEKDAYS.map((day, i) => {
                const on = query.weekdays.includes(i);
                return (
                  <Button
                    key={day}
                    variant={on ? 'secondary' : 'ghost'}
                    size="xs"
                    aria-pressed={on}
                    className={cn(on && 'shadow-[inset_0_-2px_0_var(--foreground)]')}
                    onClick={() =>
                      set({
                        weekdays: on
                          ? query.weekdays.filter((d) => d !== i)
                          : [...query.weekdays, i].sort((a, b) => a - b),
                      })
                    }
                  >
                    {day}
                  </Button>
                );
              })}
            </div>
            <div className="flex items-center gap-2">
              <label htmlFor={`${id}-hours`} className="text-muted-foreground">
                Starting
              </label>
              <NativeSelect
                id={`${id}-hours`}
                value={query.hours ? `${query.hours.from}-${query.hours.to}` : ''}
                onChange={(e) => {
                  const [from, to] = e.target.value.split('-').map(Number);
                  set({
                    hours:
                      from === undefined || to === undefined || e.target.value === ''
                        ? null
                        : { from, to },
                  });
                }}
                className="h-7 w-auto"
              >
                <option value="">any time</option>
                {TIMES_OF_DAY.map((t) => (
                  <option key={t.label} value={`${t.from}-${t.to}`}>
                    {t.label} ({formatHour(t.from)}–{formatHour(t.to)})
                  </option>
                ))}
                {query.hours &&
                  !TIMES_OF_DAY.some(
                    (t) => t.from === query.hours!.from && t.to === query.hours!.to,
                  ) && (
                    <option value={`${query.hours.from}-${query.hours.to}`}>
                      {formatHour(query.hours.from)}–{formatHour(query.hours.to)}
                    </option>
                  )}
              </NativeSelect>
            </div>
            {options.activities.length > 0 && (
              <div className="flex items-center gap-2">
                <label htmlFor={`${id}-activity`} className="text-muted-foreground">
                  Mostly
                </label>
                <NativeSelect
                  id={`${id}-activity`}
                  value={query.activity ?? ''}
                  onChange={(e) => set({ activity: e.target.value || null })}
                  className="h-7 w-auto max-w-48"
                >
                  <option value="">anything</option>
                  {options.activities.map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </NativeSelect>
              </div>
            )}
            {filtered && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => set({ minMinutes: null, weekdays: [], hours: null, activity: null })}
              >
                Clear session filters
              </Button>
            )}
          </div>
        </details>
      )}
    </div>
  );
}

/** A popover of checkboxes for a set of names; none checked means all of them. */
function NamePicker({
  label,
  all,
  names,
  value,
  onChange,
}: {
  label: string;
  all: string;
  names: readonly string[];
  value: readonly string[];
  onChange: (value: string[]) => void;
}) {
  const [draft, setDraft] = useState<string[]>([...value]);
  const summary =
    value.length === 0
      ? all
      : value.length <= 2
        ? value.join(', ')
        : `${value.length} ${label.toLowerCase()}`;
  return (
    <Popover
      onOpenChange={(open) => {
        if (open) setDraft([...value]);
        else if (draft.join() !== value.join()) onChange(draft);
      }}
    >
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" aria-label={`${label}: ${summary}`}>
          {summary}
          <ChevronDownIcon data-icon="inline-end" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="max-h-80 w-60 overflow-auto">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-muted-foreground">{label}</span>
          {draft.length > 0 && (
            <Button variant="ghost" size="xs" onClick={() => setDraft([])}>
              {all}
            </Button>
          )}
        </div>
        <ul className="flex flex-col gap-1">
          {names.map((name) => {
            const checked = draft.includes(name);
            return (
              <li key={name}>
                <label className="flex items-center gap-2 py-0.5">
                  <Checkbox
                    checked={checked}
                    onCheckedChange={(on) =>
                      setDraft((d) =>
                        on === true
                          ? names.filter((n) => d.includes(n) || n === name)
                          : d.filter((n) => n !== name),
                      )
                    }
                  />
                  {name}
                </label>
              </li>
            );
          })}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

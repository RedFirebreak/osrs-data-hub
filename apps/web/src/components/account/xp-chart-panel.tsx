'use client';
/**
 * The account page's XP chart (handoff §12): a skill selector (Overall by default) and a range picker
 * (24 hours … all time) above a step line of the skill's XP, fetched from
 * GET /api/app/accounts/[publicId]/xp with resolution auto (5 min up to 7 days, hourly up to 90, daily
 * beyond; handoff §9). While a new range loads, the previous chart stays, dimmed. The chart itself is
 * the lazy EChart (echarts never loads on the server). The dates it writes (the tooltip, "since …")
 * are in the viewer's time zone from Settings, handed in by the page; the time axis's own tick labels
 * are placed by ECharts in the browser's zone.
 */
import { formatGain } from '@hub/core';
import type { XpSeries } from '@hub/server';
import { AlertCircleIcon, RotateCwIcon } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { ChartSkeleton, LazyEChart } from '@/components/charts/lazy-echart';
import { xpChartOption, type ChartTheme } from '@/components/charts/options';
import {
  XP_RANGE_LABELS,
  XP_RANGES,
  rangeWindow,
  xpQuery,
  type XpRange,
} from '@/components/charts/ranges';
import { Button } from '@/components/ui/button';
import { formatInZone } from '@/lib/dates';
import { cn } from '@/lib/utils';
import { SkillSelect, defaultSkill } from './skill-select';

export interface XpChartPanelProps {
  publicId: string;
  /** Skills to choose from, Overall first (the skills table's rows). */
  skills: readonly string[];
  /** The account's first-seen time (ISO), where "All time" starts. */
  firstSeen: string;
  /** The viewer's time zone (Settings), for the dates in the tooltip and the "since …" text. */
  timezone: string;
}

interface Loaded {
  key: string;
  skill: string;
  range: XpRange;
  from: Date;
  to: Date;
  points: [string, number][];
}

interface Failed {
  key: string;
  error: string;
}

const SHORT_RANGE_LABELS: Readonly<Record<XpRange, string>> = {
  '24h': '24h',
  '7d': '7d',
  '30d': '30d',
  '90d': '90d',
  '1y': '1y',
  all: 'All',
};

export function XpChartPanel({ publicId, skills, firstSeen, timezone }: XpChartPanelProps) {
  const [skill, setSkill] = useState(() => defaultSkill(skills));
  const [range, setRange] = useState<XpRange>('30d');
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState<Failed | null>(null);
  const key = `${skill}|${range}|${attempt}`;

  useEffect(() => {
    if (!skill) return;
    const controller = new AbortController();
    const span = rangeWindow(range, new Date(), firstSeen);
    const url = `/api/app/accounts/${encodeURIComponent(publicId)}/xp?${xpQuery(skill, span)}`;
    fetch(url, { signal: controller.signal, credentials: 'same-origin' })
      .then(async (res) => {
        if (!res.ok) throw new Error(errorText(res.status));
        const body = (await res.json()) as XpSeries;
        const points = body.series.find((s) => s.skill === skill)?.points ?? [];
        setLoaded({ key, skill, range, ...span, points });
        setFailed(null);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setFailed({ key, error: err instanceof Error ? err.message : errorText(0) });
      });
    return () => controller.abort();
  }, [publicId, skill, range, firstSeen, key]);

  const option = useCallback(
    (theme: ChartTheme) =>
      xpChartOption(
        loaded
          ? {
              skill: loaded.skill,
              points: loaded.points,
              from: loaded.from,
              to: loaded.to,
              timezone,
            }
          : { skill, points: [], from: new Date(), to: new Date(), timezone },
        theme,
      ),
    [loaded, skill, timezone],
  );

  const error = failed?.key === key ? failed.error : null;
  const busy = loaded?.key !== key && error === null;
  const gained = loaded ? gainOf(loaded.points) : null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SkillSelect
          skills={skills}
          value={skill}
          onChange={setSkill}
          className="flex items-center gap-2"
        />
        <div
          role="group"
          aria-label="Time range"
          className="inline-flex flex-wrap rounded-lg bg-muted p-0.5"
        >
          {XP_RANGES.map((r) => (
            <button
              key={r}
              type="button"
              aria-pressed={range === r}
              // Starts with the visible text, so voice control finds it by what it shows (WCAG 2.5.3).
              aria-label={`${SHORT_RANGE_LABELS[r]} (${XP_RANGE_LABELS[r]})`}
              onClick={() => setRange(r)}
              className={cn(
                'h-7 rounded-md px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
                range === r && 'bg-background text-foreground shadow-sm dark:bg-input/30',
              )}
            >
              {SHORT_RANGE_LABELS[r]}
            </button>
          ))}
        </div>
      </div>

      <p className="min-h-5 text-sm text-muted-foreground" aria-live="polite">
        {loaded && gained !== null ? (
          <>
            <span className={cn('font-medium tabular-nums', gained > 0 && 'text-foreground')}>
              {formatGain(gained)} XP
            </span>{' '}
            in {loaded.skill}{' '}
            {trackedSince(firstSeen, loaded.from, timezone) ??
              `over ${XP_RANGE_LABELS[loaded.range].toLowerCase()}`}
          </>
        ) : busy ? (
          'Loading…'
        ) : null}
      </p>

      {error !== null ? (
        <div
          role="alert"
          className="flex h-64 flex-col items-center justify-center gap-3 rounded-lg border border-dashed text-center text-sm text-muted-foreground"
        >
          <AlertCircleIcon aria-hidden className="size-5" />
          <p>{error}</p>
          <Button size="sm" variant="outline" onClick={() => setAttempt((a) => a + 1)}>
            <RotateCwIcon aria-hidden data-icon="inline-start" />
            Try again
          </Button>
        </div>
      ) : loaded === null ? (
        <ChartSkeleton />
      ) : loaded.points.length === 0 ? (
        <div
          className={cn(
            'flex h-64 items-center justify-center rounded-lg border border-dashed px-4 text-center text-sm text-muted-foreground transition-opacity',
            busy && 'opacity-50',
          )}
        >
          No {loaded.skill} XP recorded in this range yet. XP history starts when the plugin sends
          stats while the player is logged in.
        </div>
      ) : (
        <LazyEChart
          option={option}
          busy={busy}
          label={`${loaded.skill} XP over ${XP_RANGE_LABELS[loaded.range].toLowerCase()}`}
        />
      )}
    </div>
  );
}

/**
 * "since 29 Sep, when the hub first saw this account" when the account is younger than the range:
 * "0 XP over 30 days" would claim a month of history the hub doesn't have. Null otherwise. The day is
 * the one in `timezone` (the viewer's, from Settings), as everywhere else on the account page.
 */
export function trackedSince(firstSeen: string, from: Date, timezone: string): string | null {
  const first = Date.parse(firstSeen);
  if (!Number.isFinite(first) || first <= from.getTime()) return null;
  const day = formatInZone(new Date(first), timezone, { day: 'numeric', month: 'short' });
  return `since ${day}, when the hub first saw this account`;
}

/** XP gained over the loaded points (last − first); null with fewer than one point. */
function gainOf(points: readonly [string, number][]): number | null {
  const first = points[0];
  const last = points.at(-1);
  if (!first || !last) return null;
  return last[1] - first[1];
}

function errorText(status: number): string {
  if (status === 404) return "This account's XP history isn't shared with you any more.";
  if (status === 401) return 'Your session has ended. Reload the page to sign in again.';
  if (status === 503) return 'The hub is busy. Try again in a moment.';
  return "The XP history couldn't be loaded.";
}

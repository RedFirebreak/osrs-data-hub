/**
 * "Wealth" on the character page and Home (D-125): what the character is worth now (carried plus
 * the bank, D-124), how that changed today, over 30 days and in the last play session, and a graph of
 * the 30 days whose days open in the deep dive, where each session's change is listed. Gated by
 * `inventory`, as the wealth history is: renders nothing without it. The last session also needs
 * `activity`. Async server component; the
 * page streams it behind a skeleton.
 */
import { DAY_MS, formatGp, formatGpChange, formatNumber, type Viewer } from '@hub/core';
import { getDb } from '@hub/db';
import { getSessionWealth, getWealthHistory } from '@hub/server';
import type { Route } from 'next';
import Link from 'next/link';
import { GpChange } from '@/components/common/gp-change';
import { SectionCard } from '@/components/common/section-card';
import { formatInZone } from '@/lib/dates';
import { deepDiveDayHref, deepDiveHref } from '@/lib/routes';
import { summarizeWealth, wealthPoints, type WealthPoint } from './wealth';
import { WealthGraph, type WealthGraphDay } from './wealth-graph';

/** Days the card covers. */
export const WEALTH_DAYS = 30;
/** Sessions read for "Last session": the newest one with a known change. */
const WEALTH_SESSIONS = 5;

export interface WealthCardProps {
  publicId: string;
  viewer: Viewer;
  now: Date;
}

export async function WealthCard({ publicId, viewer, now }: WealthCardProps) {
  const { db } = getDb();
  const range = { from: new Date(now.getTime() - (WEALTH_DAYS + 7) * DAY_MS), to: now };
  const [history, sessions] = await Promise.all([
    getWealthHistory(db, viewer, publicId, range),
    getSessionWealth(
      db,
      viewer,
      publicId,
      { from: new Date(now.getTime() - WEALTH_DAYS * DAY_MS), to: now },
      WEALTH_SESSIONS,
    ),
  ]);
  if (history === null) return null;
  const points = wealthPoints(history, { now, days: WEALTH_DAYS });
  const { latest, today, window } = summarizeWealth(history, points);
  const href = `${deepDiveHref(publicId)}#wealth` as Route;
  const lastSession = (sessions ?? []).find((s) => s.change !== null) ?? null;

  return (
    <SectionCard
      id="wealth"
      title="Wealth"
      action={
        <Link
          href={href}
          className="text-sm font-medium underline-offset-4 hover:underline focus-visible:underline"
        >
          Deep dive
        </Link>
      }
    >
      {latest === null ? (
        <p className="text-sm text-muted-foreground">
          No wealth yet. It is counted from the inventory and the gear while the plugin runs, and
          the bank once the bank has been opened.
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          <div>
            <p
              className="text-3xl leading-tight font-semibold tracking-tight tabular-nums"
              title={`${formatNumber(latest.lastValue)} gp`}
            >
              {formatGp(latest.lastValue)} gp
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {latest.bankValue === null ? (
                'Carried only: the bank is counted once the plugin has seen it opened'
              ) : (
                <>
                  {formatGp(latest.bankValue)} in the bank,{' '}
                  {formatGp(latest.lastValue - latest.bankValue)} carried
                </>
              )}
            </p>
          </div>
          <dl className="grid grid-cols-3 gap-3">
            <ChangeStat label="Today" value={today} />
            <ChangeStat label="30 days" value={window} />
            <ChangeStat
              label="Last session"
              value={lastSession?.change ?? null}
              hidden={sessions === null}
            />
          </dl>
          <WealthGraph
            days={graphDays(points, publicId)}
            firstLabel={dayText((points[0] as WealthPoint).day, {
              day: 'numeric',
              month: 'short',
            })}
          />
        </div>
      )}
    </SectionCard>
  );
}

function ChangeStat({
  label,
  value,
  hidden = false,
}: {
  label: string;
  value: number | null;
  hidden?: boolean;
}) {
  if (hidden) return <div aria-hidden />;
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-base font-semibold">
        {value === null ? (
          <span className="font-normal text-muted-foreground">—</span>
        ) : (
          <GpChange value={value} suffix="" />
        )}
      </dd>
    </div>
  );
}

/** A UTC day (YYYY-MM-DD) as a date: noon UTC of it is that day in UTC. */
function dayText(day: string, options: Intl.DateTimeFormatOptions): string {
  return formatInZone(`${day}T12:00:00Z`, 'UTC', options) ?? day;
}

/** The graph's days, with their texts and the link to each day in the deep dive. */
function graphDays(points: readonly WealthPoint[], publicId: string): WealthGraphDay[] {
  return points.map((p) => ({
    ...p,
    label: dayText(p.day, { weekday: 'short', day: 'numeric', month: 'short' }),
    valueText: p.value === null ? null : formatGp(p.value),
    bankText: p.bank === null ? null : formatGp(p.bank),
    changeText: p.change === null ? null : formatGpChange(p.change),
    href: deepDiveDayHref(publicId, p.day),
  }));
}

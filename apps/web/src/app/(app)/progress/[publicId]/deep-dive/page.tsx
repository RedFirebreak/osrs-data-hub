/**
 * Deep dive (D-106), one level under Progress: how the player is doing and when they are
 * effective, over a range and the filters in the URL. Totals, a chosen session's timeline, the period comparison,
 * the effective-hours heatmap, the sessions scatter, the rate through a session, where the time
 * goes, the session recaps, the skills, the bosses and the goals, all from @hub/server
 * getAccountMetrics, which leaves out every panel whose sharing category the viewer lacks. Under
 * them, whatever the range: playtime per day with the recent sessions, and carried wealth per day.
 *
 * Not at /metrics: that is the hub's Prometheus endpoint. The visibility check runs before anything
 * streams, so an unknown account is a real 404 (NEXT-14).
 */
import {
  DAY_MS,
  OVERALL,
  getConfig,
  parseMetricsQuery,
  type MetricsMeasure,
  type MetricsQuery,
} from '@hub/core';
import { getDb } from '@hub/db';
import {
  getAccountMetrics,
  getSessions,
  getUserSettings,
  getWealthHistory,
  type AccountMetrics,
} from '@hub/server';
import { ChevronLeftIcon } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Suspense } from 'react';
import { ActivityContent } from '@/components/account-page/activity-section';
import { playtimeByDay } from '@/components/account-page/playtime';
import { AccountTypeBadge } from '@/components/accounts/account-type-badge';
import { MODE_LABELS } from '@/components/account-page/hiscores-content';
import { MOMENT_OPTIONS } from '@/components/charts/options';
import { WealthChart } from '@/components/charts/wealth-chart';
import { CardSkeleton } from '@/components/common/card-skeleton';
import { SectionCard } from '@/components/common/section-card';
import { FilterBar } from '@/components/metrics/filter-bar';
import { MEASURE_LABELS, formatMs, formatShare } from '@/components/metrics/format';
import { GoalsPanel } from '@/components/metrics/goals-panel';
import {
  ComparisonChart,
  HeatmapChart,
  RateThroughChart,
  SessionTimelineChart,
  SessionsScatter,
  TimeByActivityChart,
} from '@/components/metrics/metrics-charts';
import { MetricsQueryProvider } from '@/components/metrics/metrics-nav';
import {
  BossesTable,
  SessionList,
  SkillsProgress,
  TotalsTiles,
} from '@/components/metrics/metrics-panels';
import { Skeleton } from '@/components/ui/skeleton';
import { formatInZone } from '@/lib/dates';
import { deepDiveHref, progressHref } from '@/lib/routes';
import { requireUser } from '@/lib/session';
import { loadVisible } from '@/lib/visible-account';

/** Days of play sessions behind the playtime chart and the sessions list. */
const ACTIVITY_DAYS = 30;
/** Days of wealth shown. */
const HISTORY_DAYS = 90;

export async function generateMetadata({
  params,
}: PageProps<'/progress/[publicId]/deep-dive'>): Promise<Metadata> {
  const { publicId } = await params;
  const visible = await loadVisible(publicId);
  return { title: `${visible?.account.name ?? 'Account'} · Deep dive · ${getConfig().hubName}` };
}

export default async function MetricsPage({
  params,
  searchParams,
}: PageProps<'/progress/[publicId]/deep-dive'>) {
  const { publicId } = await params;
  // See NEXT-14: before any Suspense boundary, so the answer is a real 404.
  const visible = await loadVisible(publicId);
  if (!visible) notFound();
  const query = parseMetricsQuery(await searchParams);
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <Link
          href={progressHref(publicId)}
          className="flex w-fit items-center gap-1 rounded-md text-sm text-muted-foreground hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          <ChevronLeftIcon aria-hidden className="size-4" />
          Progress of {visible.account.name}
        </Link>
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
          <h1 className="text-3xl leading-tight font-semibold tracking-tight sm:text-4xl">
            Deep dive
          </h1>
          <AccountTypeBadge accountType={visible.account.accountType} />
        </div>
        <p className="max-w-prose text-sm text-muted-foreground">
          Sessions, the hours {visible.account.name} is most effective, rates and filters. The
          address holds the view, so it can be bookmarked or sent.
        </p>
      </header>
      <MetricsQueryProvider query={query}>
        <Suspense fallback={<MetricsSkeleton />}>
          <MetricsContent publicId={publicId} query={query} />
        </Suspense>
      </MetricsQueryProvider>
    </div>
  );
}

async function MetricsContent({ publicId, query }: { publicId: string; query: MetricsQuery }) {
  const { user, viewer } = await requireUser();
  const { db } = getDb();
  const { timezone } = await getUserSettings(db, user.id);
  const m = await getAccountMetrics(db, viewer, publicId, query, { now: new Date(), timezone });
  if (!m) notFound();
  const path = deepDiveHref(publicId);
  const measures: Record<MetricsMeasure, boolean> = {
    xp: m.access.stats,
    gp: m.access.events,
    kills: m.access.hiscores,
    active: m.access.sessions,
  };
  const rangeText = `${formatInZone(m.range.from, timezone, MOMENT_OPTIONS)} to ${formatInZone(
    m.range.to,
    timezone,
    MOMENT_OPTIONS,
  )}`;

  return (
    <>
      <FilterBar
        measures={measures}
        sessions={m.access.sessions}
        options={m.options}
        range={m.range}
        timezone={timezone}
        sessionStart={m.timeline?.session.start ?? null}
      />
      <p className="-mt-3 text-xs text-muted-foreground">
        {rangeText}, in your time zone.
        {m.matching &&
          ` The session charts show the ${m.matching.sessions} ${
            m.matching.sessions === 1 ? 'session' : 'sessions'
          } that match the filters; the totals cover the whole range.`}
      </p>
      <TotalsTiles m={m} />
      {m.timeline && <TimelineSection m={m} timezone={timezone} />}
      {query.session && !m.timeline && m.access.sessions && (
        <SectionCard
          id="timeline"
          title="Session not found"
          description="This account has no such session. It may be from before the hub kept sessions."
        />
      )}
      <SectionCard
        id="comparison"
        title={`${MEASURE_LABELS[query.measure]} through the range`}
        description={
          query.compare
            ? 'Adding up as the range goes, with the period of the same length before it.'
            : 'Adding up as the range goes. Turn on "Compare" to lay the period before over it.'
        }
      >
        {m.comparison ? (
          <ComparisonChart
            comparison={m.comparison}
            measure={query.measure}
            from={m.range.from}
            to={m.range.to}
            timezone={timezone}
          />
        ) : (
          <NotShared what={MEASURE_LABELS[query.measure].toLowerCase()} />
        )}
      </SectionCard>
      <SessionCharts m={m} query={query} timezone={timezone} />
      <SectionCard
        id="sessions"
        title="Sessions"
        description={
          m.totals.sessions
            ? `Each play session, newest first, with its effective share: the time with XP or drops.`
            : undefined
        }
      >
        {m.access.sessions ? (
          <SessionList m={m} query={query} path={path} timezone={timezone} />
        ) : (
          <NotShared what="play sessions" />
        )}
      </SectionCard>
      <div className="grid items-start gap-6 lg:grid-cols-3">
        <div className="flex min-w-0 flex-col gap-6 lg:col-span-2">
          {m.skills && (
            <SectionCard
              id="skills"
              title="Skills"
              description="XP gained in the range, XP per active hour while training it, and the play time to the next level at that rate."
              contentClassName="px-0 sm:px-(--card-spacing)"
            >
              <SkillsProgress skills={m.skills} />
            </SectionCard>
          )}
          {m.bosses && (
            <SectionCard
              id="bosses"
              title="Bosses"
              description="Kill counts from the official hiscores, and the kills read in the range. Open a boss for its loot, uniques and sessions."
              contentClassName="px-0 sm:px-(--card-spacing)"
            >
              {m.bosses.length === 0 ? (
                <p className="px-(--card-spacing) text-sm text-muted-foreground sm:px-0">
                  No boss kill counts on the hiscores yet. Most bosses show from 5 kills.
                </p>
              ) : (
                <BossesTable
                  bosses={m.bosses}
                  publicId={publicId}
                  query={query}
                  showGp={m.access.events}
                  modeLabel={m.hiscores ? MODE_LABELS[m.hiscores.mode] : null}
                />
              )}
            </SectionCard>
          )}
        </div>
        <SectionCard
          id="goals"
          title="Goals"
          description="ETAs use the pace of the range you are looking at."
        >
          <GoalsPanel
            publicId={publicId}
            goals={m.goals}
            canSet={m.canSetGoals}
            skills={m.access.stats ? m.options.skills.filter((s) => s !== OVERALL) : []}
            bosses={m.access.hiscores ? m.options.bosses : []}
          />
        </SectionCard>
      </div>
      {(m.access.activity || m.access.inventory) && (
        <div className="grid items-start gap-6 lg:grid-cols-2">
          {m.access.activity && (
            <SectionCard
              id="activity"
              title="Sessions & playtime"
              description={`The last ${ACTIVITY_DAYS} days, in your time zone, whatever the range above.`}
            >
              <Suspense fallback={<Skeleton className="h-64 w-full rounded-lg" />}>
                <ActivityLoader publicId={publicId} timezone={timezone} />
              </Suspense>
            </SectionCard>
          )}
          {m.access.inventory && (
            <SectionCard
              id="wealth"
              title="Wealth"
              description={`Carried value (inventory and gear) per day, last ${HISTORY_DAYS} days.`}
            >
              <Suspense fallback={<Skeleton className="h-64 w-full rounded-lg" />}>
                <WealthLoader publicId={publicId} />
              </Suspense>
            </SectionCard>
          )}
        </div>
      )}
    </>
  );
}

/** Playtime per day and the recent sessions with their worlds: the `activity` category. */
async function ActivityLoader({ publicId, timezone }: { publicId: string; timezone: string }) {
  const { viewer } = await requireUser();
  const to = new Date();
  const sessions = await getSessions(getDb().db, viewer, publicId, {
    from: new Date(to.getTime() - ACTIVITY_DAYS * DAY_MS),
    to,
  });
  if (sessions === null) return <NotShared what="play sessions" />;
  const playtime = playtimeByDay(sessions, { now: to, days: ACTIVITY_DAYS, timezone });
  return <ActivityContent sessions={sessions} playtime={playtime} timezone={timezone} />;
}

/** Carried wealth per day: the `inventory` category. */
async function WealthLoader({ publicId }: { publicId: string }) {
  const { viewer } = await requireUser();
  const to = new Date();
  const days = await getWealthHistory(getDb().db, viewer, publicId, {
    from: new Date(to.getTime() - HISTORY_DAYS * DAY_MS),
    to,
  });
  if (days === null) return <NotShared what="inventory" />;
  if (days.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No wealth history yet. It builds up day by day while the plugin sends the inventory.
      </p>
    );
  }
  return <WealthChart days={days} />;
}

function TimelineSection({ m, timezone }: { m: AccountMetrics; timezone: string }) {
  const timeline = m.timeline!;
  const s = timeline.session;
  return (
    <SectionCard
      id="timeline"
      title={`Session of ${formatInZone(s.start, timezone, MOMENT_OPTIONS)}`}
      description={`${formatMs(s.onlineMs)} online${s.open ? ' so far' : ''}, ${formatShare(
        s.activeMs,
        s.onlineMs,
      )} active${s.main ? `, mostly ${s.main.name}` : ''}.`}
      className="ring-2 ring-foreground/30"
    >
      <SessionTimelineChart timeline={timeline} timezone={timezone} />
    </SectionCard>
  );
}

function SessionCharts({
  m,
  query,
  timezone,
}: {
  m: AccountMetrics;
  query: MetricsQuery;
  timezone: string;
}) {
  if (!m.access.sessions) {
    return (
      <SectionCard
        id="effective"
        title="Effective time"
        description="When the play is effective, session by session."
      >
        <NotShared what="play sessions or stats" />
      </SectionCard>
    );
  }
  const sessions = m.sessions ?? [];
  return (
    <>
      <div className="grid items-start gap-6 lg:grid-cols-2">
        <SectionCard
          id="heatmap"
          title="When it hits"
          description={`${MEASURE_LABELS[query.measure]} by weekday and hour, in your time zone.`}
        >
          <HeatmapChart
            cells={m.heatmap ?? []}
            sessions={sessions}
            measure={query.measure}
            timezone={timezone}
          />
        </SectionCard>
        <SectionCard
          id="scatter"
          title="Sessions by length and rate"
          description={`${MEASURE_LABELS[query.measure]} per online hour, coloured by what the session was mostly.`}
        >
          {sessions.length === 0 ? (
            <Empty />
          ) : (
            <SessionsScatter
              sessions={sessions}
              measure={query.measure}
              activities={m.options.activities}
              timezone={timezone}
            />
          )}
        </SectionCard>
      </div>
      <div className="grid items-start gap-6 lg:grid-cols-2">
        <SectionCard
          id="rate-through"
          title="Rate through a session"
          description="Whether sessions fall off after an hour or two."
        >
          {query.measure === 'kills' ? (
            <p className="text-sm text-muted-foreground">
              Kill counts come from the hiscores after a session, so there is no rate within one.
              Pick XP, loot or active time.
            </p>
          ) : (m.rateThrough ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {sessions.length === 0
                ? 'No play sessions in this range.'
                : 'No session in this range lasted half an hour yet.'}
            </p>
          ) : (
            <RateThroughChart steps={m.rateThrough!} measure={query.measure} />
          )}
        </SectionCard>
        <SectionCard
          id="time"
          title="Where the time goes"
          description="Active hours per day, by what they went to."
        >
          {!m.timeByActivity || m.timeByActivity.days.length === 0 ? (
            <Empty />
          ) : (
            <TimeByActivityChart data={m.timeByActivity} activities={m.options.activities} />
          )}
        </SectionCard>
      </div>
    </>
  );
}

function Empty() {
  return <p className="text-sm text-muted-foreground">No play sessions in this range.</p>;
}

function NotShared({ what }: { what: string }) {
  return (
    <p className="text-sm text-muted-foreground">
      The owner of this account doesn&apos;t share its {what} with you.
    </p>
  );
}

function MetricsSkeleton() {
  return (
    <div className="flex flex-col gap-6" role="status" aria-label="Loading the metrics">
      <Skeleton className="h-24 w-full rounded-xl" />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-20 rounded-xl" />
        ))}
      </div>
      <CardSkeleton chart />
      <div className="grid gap-6 lg:grid-cols-2">
        <CardSkeleton chart />
        <CardSkeleton chart />
      </div>
    </div>
  );
}

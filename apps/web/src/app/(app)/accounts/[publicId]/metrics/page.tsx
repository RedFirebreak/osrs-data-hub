/**
 * The Metrics tab of an account (D-106): how the player is doing and when they are effective, over
 * a range and the filters in the URL. Totals, a chosen session's timeline, the period comparison,
 * the effective-hours heatmap, the sessions scatter, the rate through a session, where the time
 * goes, the session recaps, the skills, the bosses and the goals, all from @hub/server
 * getAccountMetrics, which leaves out every panel whose sharing category the viewer lacks.
 *
 * Not at /metrics: that is the hub's Prometheus endpoint. The visibility check runs before anything
 * streams, so an unknown account is a real 404 (NEXT-14).
 */
import {
  OVERALL,
  getConfig,
  parseMetricsQuery,
  type MetricsMeasure,
  type MetricsQuery,
} from '@hub/core';
import { getDb } from '@hub/db';
import { getAccountMetrics, getUserSettings, type AccountMetrics } from '@hub/server';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Suspense } from 'react';
import { AccountTypeBadge } from '@/components/accounts/account-type-badge';
import { MODE_LABELS } from '@/components/account-page/hiscores-content';
import { MOMENT_OPTIONS } from '@/components/charts/options';
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
  AccountTabs,
  BossesTable,
  SessionList,
  SkillsProgress,
  TotalsTiles,
} from '@/components/metrics/metrics-panels';
import { Skeleton } from '@/components/ui/skeleton';
import { formatInZone } from '@/lib/dates';
import { requireUser } from '@/lib/session';
import { loadVisible } from '../visible';

export async function generateMetadata({
  params,
}: PageProps<'/accounts/[publicId]/metrics'>): Promise<Metadata> {
  const { publicId } = await params;
  const visible = await loadVisible(publicId);
  return { title: `${visible?.account.name ?? 'Account'} · Metrics · ${getConfig().hubName}` };
}

export default async function MetricsPage({
  params,
  searchParams,
}: PageProps<'/accounts/[publicId]/metrics'>) {
  const { publicId } = await params;
  // See NEXT-14: before any Suspense boundary, so the answer is a real 404.
  const visible = await loadVisible(publicId);
  if (!visible) notFound();
  const query = parseMetricsQuery(await searchParams);
  return (
    <div className="metrics flex flex-col gap-6">
      <header className="flex flex-col gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
          <h1 className="min-w-0 text-2xl font-semibold tracking-tight break-words">
            {visible.account.name}
          </h1>
          <AccountTypeBadge accountType={visible.account.accountType} />
        </div>
        <AccountTabs publicId={publicId} active="metrics" />
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
  const path = `/accounts/${publicId}/metrics`;
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
    </>
  );
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
      className="ring-2 ring-metrics-accent/40"
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

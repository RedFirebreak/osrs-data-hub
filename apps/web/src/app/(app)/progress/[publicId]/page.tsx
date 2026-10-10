/**
 * Progress of a character: what changed over time, answered first with one number and one line
 * ("+1,265,900 XP in the last 7 days"), with a range (1D … 1Y) and what is counted (XP, loot, boss
 * kills, play time) in the address. Under it the skills that were trained, the bosses, the goals,
 * and the way into Deep dive for sessions, rates and filters (D-106).
 *
 * Reads the Metrics read model (getAccountMetrics), so every part follows its sharing category and
 * is left out, or says "not shared", without it. The visibility check runs before anything streams,
 * so an unknown account is a real 404 (NEXT-14).
 */
import {
  DEFAULT_METRICS_QUERY,
  OVERALL,
  formatNumber,
  getConfig,
  metricsSearch,
  type MetricsMeasure,
} from '@hub/core';
import { getDb } from '@hub/db';
import { getAccountMetrics, getUserSettings, type AccountMetrics } from '@hub/server';
import { ChevronRightIcon } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Suspense } from 'react';
import { CharacterPicker } from '@/components/accounts/character-picker';
import { CardSkeleton } from '@/components/common/card-skeleton';
import { SectionCard } from '@/components/common/section-card';
import { formatMs } from '@/components/metrics/format';
import { GoalsPanel } from '@/components/metrics/goals-panel';
import { ProgressHeadline } from '@/components/progress/headline';
import { totalLevelsGained } from '@/components/progress/levels';
import { MeasurePills } from '@/components/progress/measure-pills';
import { ProgressChart } from '@/components/progress/progress-chart';
import { ProgressQueryProvider } from '@/components/progress/progress-nav';
import { RangeControl } from '@/components/progress/range-control';
import { TrainedSkills, mostTrained } from '@/components/progress/trained-skills';
import { PageHeader } from '@/components/shell/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { loadOwnAccounts } from '@/lib/own-accounts';
import {
  PROGRESS_MEASURE_LABELS,
  PROGRESS_RANGES,
  PROGRESS_RANGE_WORDS,
  deepDiveRange,
  parseProgressQuery,
  progressMetricsQuery,
  progressSearch,
  type ProgressQuery,
} from '@/lib/progress';
import { bossHref, deepDiveHref, progressHref } from '@/lib/routes';
import { requireUser } from '@/lib/session';
import { loadVisible } from '@/lib/visible-account';

/** Bosses listed on the summary; the rest are a click away on Deep dive. */
const BOSSES_SHOWN = 6;

export async function generateMetadata({
  params,
}: PageProps<'/progress/[publicId]'>): Promise<Metadata> {
  const { publicId } = await params;
  const visible = await loadVisible(publicId);
  return { title: `${visible?.account.name ?? 'Account'} · Progress · ${getConfig().hubName}` };
}

export default async function ProgressPage({
  params,
  searchParams,
}: PageProps<'/progress/[publicId]'>) {
  const { publicId } = await params;
  // See NEXT-14: before any Suspense boundary, so the answer is a real 404.
  const visible = await loadVisible(publicId);
  if (!visible) notFound();
  const query = parseProgressQuery(await searchParams);
  const own = await loadOwnAccounts();
  const isOwn = own.some((account) => account.publicId === publicId);
  const search = progressSearch(query);
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Progress"
        description={
          isOwn
            ? `How ${visible.account.name} is coming along.`
            : `How ${visible.account.name}, a guild member's character, is coming along.`
        }
        actions={
          // Nothing to pick with a single character of your own on screen.
          own.length > (isOwn ? 1 : 0) ? (
            <CharacterPicker
              current={publicId}
              options={own.map((account) => ({
                ...account,
                href: progressHref(account.publicId, search),
              }))}
            />
          ) : undefined
        }
      />
      <ProgressQueryProvider query={query}>
        <Suspense fallback={<ProgressSkeleton />}>
          <ProgressContent publicId={publicId} query={query} />
        </Suspense>
      </ProgressQueryProvider>
    </div>
  );
}

async function ProgressContent({ publicId, query }: { publicId: string; query: ProgressQuery }) {
  const { user, viewer } = await requireUser();
  const { db } = getDb();
  const { timezone } = await getUserSettings(db, user.id);
  const now = new Date();
  const m = await getAccountMetrics(db, viewer, publicId, progressMetricsQuery(query, now), {
    now,
    timezone,
    fineSteps: true,
  });
  if (!m) notFound();
  const words = PROGRESS_RANGE_WORDS[query.range];
  const available: Record<MetricsMeasure, boolean> = {
    xp: m.access.stats,
    gp: m.access.events,
    kills: m.access.hiscores,
    active: m.access.sessions,
  };
  const deepDive = deepDiveHref(
    publicId,
    metricsSearch({
      ...DEFAULT_METRICS_QUERY,
      range: deepDiveRange(query.range),
      measure: query.measure,
    }),
  );
  return (
    <>
      <AnswerCard m={m} query={query} available={available} timezone={timezone} words={words} />
      <div className="grid items-start gap-6 lg:grid-cols-3">
        {m.skills && (
          <SectionCard
            id="trained"
            title="Skills trained"
            description="Pick a skill for its own graph."
            className="lg:col-span-2"
          >
            {mostTrained(m.skills).length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No XP gained {words}. A skill shows up here once it is trained with RuneLite
                running, or after the hub next reads the hiscores.
              </p>
            ) : (
              <TrainedSkills publicId={publicId} skills={m.skills} period={words} />
            )}
          </SectionCard>
        )}
        <div className="flex min-w-0 flex-col gap-6">
          {m.bosses && <BossesCard m={m} publicId={publicId} query={query} words={words} />}
          <SectionCard id="goals" title="Goals" description={`At the pace of ${paceOf(query)}.`}>
            <GoalsPanel
              publicId={publicId}
              goals={m.goals}
              canSet={m.canSetGoals}
              skills={m.access.stats ? m.options.skills.filter((s) => s !== OVERALL) : []}
              bosses={m.access.hiscores ? m.options.bosses : []}
            />
          </SectionCard>
        </div>
      </div>
      <Link
        href={deepDive}
        className="pressable flex items-center justify-between gap-4 rounded-xl bg-card p-4 ring-1 ring-foreground/10 hover:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        <span className="flex flex-col gap-0.5">
          <span className="text-base font-semibold">Deep dive</span>
          <span className="text-sm text-muted-foreground">
            Sessions, the hours you are most effective, rates, and filters for all of it.
          </span>
        </span>
        <ChevronRightIcon aria-hidden className="size-5 shrink-0 text-muted-foreground" />
      </Link>
    </>
  );
}

/** "the last 7 days", for the goals' pace line. */
function paceOf(query: ProgressQuery): string {
  return PROGRESS_RANGE_WORDS[query.range].replace(/^in /, '');
}

/** What the headline adds in words, per measure: levels, drops, time online. */
function footnote(m: AccountMetrics, measure: MetricsMeasure): string | null {
  switch (measure) {
    case 'xp': {
      const levels = m.skills ? totalLevelsGained(m.skills) : 0;
      return levels > 0
        ? `${formatNumber(levels)} ${levels === 1 ? 'level' : 'levels'} gained`
        : null;
    }
    case 'gp': {
      const drops = m.totals.drops ?? 0;
      return drops > 0 ? `from ${formatNumber(drops)} ${drops === 1 ? 'drop' : 'drops'}` : null;
    }
    case 'active': {
      const online = m.totals.sessions?.onlineMs ?? 0;
      return online > 0 ? `of ${formatMs(online)} online` : null;
    }
    case 'kills':
      return null;
  }
}

function AnswerCard({
  m,
  query,
  available,
  timezone,
  words,
}: {
  m: AccountMetrics;
  query: ProgressQuery;
  available: Readonly<Record<MetricsMeasure, boolean>>;
  timezone: string;
  words: string;
}) {
  const label = PROGRESS_MEASURE_LABELS[query.measure];
  const line = m.comparison?.current ?? null;
  // The chart's own last value, so the headline and the line always agree.
  const total = line?.at(-1)?.[1] ?? 0;
  const extra = footnote(m, query.measure);
  return (
    <Card aria-labelledby="answer-heading" role="region">
      <CardContent className="flex flex-col gap-4">
        <h2 id="answer-heading" className="sr-only">
          {label} {words}
        </h2>
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
          <div className="flex min-w-0 flex-col gap-2">
            {line ? (
              <ProgressHeadline value={total} measure={query.measure} />
            ) : (
              <p className="text-2xl font-semibold tracking-tight">Not shared</p>
            )}
            <p className="text-sm text-muted-foreground">
              {words}
              {line && extra && `, ${extra}`}
            </p>
          </div>
          <RangeControl ranges={PROGRESS_RANGES} />
        </div>
        <MeasurePills available={available} />
        {line ? (
          <ProgressChart
            points={line}
            from={m.range.from}
            to={m.range.to}
            measure={query.measure}
            skill={null}
            name={label}
            label={`${label} adding up ${words}`}
            timezone={timezone}
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            The owner of this character doesn&apos;t share its {label.toLowerCase()} with you.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function BossesCard({
  m,
  publicId,
  query,
  words,
}: {
  m: AccountMetrics;
  publicId: string;
  query: ProgressQuery;
  words: string;
}) {
  const bosses = (m.bosses ?? []).slice(0, BOSSES_SHOWN);
  // A boss page has a range of its own (a Metrics query): hand it the closest one.
  const search = metricsSearch({ ...DEFAULT_METRICS_QUERY, range: deepDiveRange(query.range) });
  return (
    <SectionCard id="bosses" title="Bosses" description={`Kills ${words}, from the hiscores.`}>
      {bosses.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No boss kill counts on the hiscores yet. Most bosses show from 5 kills.
        </p>
      ) : (
        <ul className="-mx-2 flex flex-col">
          {bosses.map((boss) => (
            <li key={boss.activity}>
              <Link
                href={bossHref(publicId, boss.activity, search)}
                className="pressable flex items-center justify-between gap-3 rounded-lg px-2 py-2 text-sm hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
              >
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{boss.activity}</span>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {formatNumber(boss.score)} kills in total
                  </span>
                </span>
                <span
                  className={
                    boss.gained > 0
                      ? 'font-medium tabular-nums'
                      : 'text-muted-foreground tabular-nums'
                  }
                >
                  {boss.gained > 0 ? `+${formatNumber(boss.gained)}` : '0'}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

function ProgressSkeleton() {
  return (
    <div className="flex flex-col gap-6" role="status" aria-label="Loading the progress">
      <div className="flex flex-col gap-4 rounded-xl p-4 ring-1 ring-foreground/10">
        <Skeleton className="h-12 w-72 max-w-full" />
        <Skeleton className="h-7 w-80 max-w-full rounded-full" />
        <Skeleton className="h-72 w-full rounded-lg" />
      </div>
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <CardSkeleton rows={6} rowClassName="h-8 w-full" />
        </div>
        <CardSkeleton rows={4} />
      </div>
    </div>
  );
}

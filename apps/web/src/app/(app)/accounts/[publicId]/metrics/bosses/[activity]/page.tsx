/**
 * One boss of an account (D-108): its kill count with the main and iron ranks, the kills read in the
 * range per day or week, loot per kill and loot against kills, the uniques with the kills since the
 * last one, the best drops, and the sessions it was killed in with the time per kill. From
 * @hub/server getBossMetrics: it needs `hiscores`; loot needs `events`, sessions `activity`.
 *
 * `activity` is the name as the hiscores write it ("Zulrah", "TzKal-Zuk"), URL-encoded. The checks
 * that answer 404 (account visible, `hiscores` readable, the name a boss) run before anything
 * streams (NEXT-14).
 */
import {
  activityKind,
  formatGp,
  formatNumber,
  getConfig,
  metricsSearch,
  parseMetricsQuery,
  type MetricsQuery,
} from '@hub/core';
import { getDb } from '@hub/db';
import { getBossMetrics, getUserSettings, type BossMetricsPage } from '@hub/server';
import { ChevronLeftIcon } from 'lucide-react';
import type { Metadata, Route } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Suspense } from 'react';
import { MODE_LABELS } from '@/components/account-page/hiscores-content';
import { MOMENT_OPTIONS } from '@/components/charts/options';
import { CardSkeleton } from '@/components/common/card-skeleton';
import { SectionCard } from '@/components/common/section-card';
import { BossKillsChart, BossLootChart } from '@/components/metrics/boss-charts';
import { FilterBar } from '@/components/metrics/filter-bar';
import { formatMs } from '@/components/metrics/format';
import { MetricsQueryProvider } from '@/components/metrics/metrics-nav';
import { AccountTabs, sessionHref } from '@/components/metrics/metrics-panels';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatInZone } from '@/lib/dates';
import { requireUser } from '@/lib/session';
import { cn } from '@/lib/utils';
import { loadVisible } from '../../../visible';

/** The boss name from the route, or null when it can't be one. */
function bossName(raw: string): string | null {
  let name = raw;
  try {
    name = decodeURIComponent(raw);
  } catch {
    return null;
  }
  return name.length <= 64 && activityKind(name) === 'boss' ? name : null;
}

export async function generateMetadata({
  params,
}: PageProps<'/accounts/[publicId]/metrics/bosses/[activity]'>): Promise<Metadata> {
  const { publicId, activity } = await params;
  const visible = await loadVisible(publicId);
  const name = bossName(activity) ?? 'Boss';
  return { title: `${name} · ${visible?.account.name ?? 'Account'} · ${getConfig().hubName}` };
}

export default async function BossPage({
  params,
  searchParams,
}: PageProps<'/accounts/[publicId]/metrics/bosses/[activity]'>) {
  const { publicId, activity: raw } = await params;
  // See NEXT-14: every 404 before the Suspense boundary.
  const visible = await loadVisible(publicId);
  const activity = bossName(raw);
  if (!visible || !activity || !visible.access.categories.has('hiscores')) notFound();
  const query = parseMetricsQuery(await searchParams);
  const metricsPath = `/accounts/${publicId}/metrics`;
  const back = metricsSearch({ ...query, session: null });
  return (
    <div className="metrics flex flex-col gap-6">
      <header className="flex flex-col gap-3">
        <Link
          href={(back ? `${metricsPath}?${back}` : metricsPath) as Route}
          className="flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronLeftIcon aria-hidden className="size-4" />
          {visible.account.name}
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">{activity}</h1>
        <AccountTabs publicId={publicId} active="metrics" />
      </header>
      <MetricsQueryProvider query={query}>
        <Suspense
          fallback={
            <div className="flex flex-col gap-6" role="status" aria-label="Loading the boss">
              <CardSkeleton rows={2} />
              <CardSkeleton chart />
            </div>
          }
        >
          <BossContent publicId={publicId} activity={activity} query={query} />
        </Suspense>
      </MetricsQueryProvider>
    </div>
  );
}

async function BossContent({
  publicId,
  activity,
  query,
}: {
  publicId: string;
  activity: string;
  query: MetricsQuery;
}) {
  const { user, viewer } = await requireUser();
  const { db } = getDb();
  const { timezone } = await getUserSettings(db, user.id);
  const page = await getBossMetrics(db, viewer, publicId, activity, query, {
    now: new Date(),
    timezone,
  });
  if (!page) notFound();
  const metricsPath = `/accounts/${publicId}/metrics`;
  return (
    <>
      <FilterBar
        measures={{ xp: false, gp: false, kills: true, active: false }}
        sessions={false}
        options={{ skills: [], bosses: [], activities: [] }}
        range={page.range}
        timezone={timezone}
        sessionStart={null}
        rangeOnly
      />
      <BossTiles page={page} />
      <div className="grid items-start gap-6 lg:grid-cols-2">
        <SectionCard
          id="kills"
          title="Kills"
          description={`Kills read from the hiscores per ${page.step}, in your time zone.`}
        >
          <BossKillsChart periods={page.periods} step={page.step} activity={activity} />
        </SectionCard>
        {page.gp !== null && (
          <SectionCard
            id="loot"
            title="Loot against kills"
            description="Loot so far against kills so far, from the plugin's drops."
          >
            {page.periods.some((p) => p.kills > 0 || (p.gp ?? 0) > 0) ? (
              <BossLootChart periods={page.periods} step={page.step} activity={activity} />
            ) : (
              <p className="text-sm text-muted-foreground">
                No kills or loot from it in this range.
              </p>
            )}
          </SectionCard>
        )}
      </div>
      {page.uniques !== null && (
        <div className="grid items-start gap-6 lg:grid-cols-2">
          <SectionCard
            id="uniques"
            title="Uniques"
            description="Collection log entries that came with a drop from this boss, newest first, all time."
          >
            {page.uniques.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No collection log entries from it yet.
              </p>
            ) : (
              <Table className="tabular-nums">
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead scope="col">Item</TableHead>
                    <TableHead scope="col">When</TableHead>
                    <TableHead scope="col" className="text-right">
                      Kill count
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {page.uniques.map((u) => (
                    <TableRow key={u.at}>
                      <TableHead scope="row" className="font-medium">
                        {u.item ?? 'Unknown item'}
                      </TableHead>
                      <TableCell>{formatInZone(u.at, timezone, MOMENT_OPTIONS)}</TableCell>
                      <TableCell className="text-right">{formatNumber(u.killCount)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </SectionCard>
          <SectionCard
            id="drops"
            title="Best drops"
            description="The most valuable drops in the range."
          >
            {(page.topDrops ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">No drops from it in this range.</p>
            ) : (
              <ol className="flex flex-col divide-y text-sm tabular-nums">
                {page.topDrops!.map((d) => (
                  <li key={d.at} className="flex justify-between gap-3 py-1.5">
                    <span className="text-muted-foreground">
                      {formatInZone(d.at, timezone, MOMENT_OPTIONS)}
                    </span>
                    <span className="font-medium">{formatGp(d.value)} gp</span>
                  </li>
                ))}
              </ol>
            )}
          </SectionCard>
        </div>
      )}
      {page.sessions !== null && (
        <SectionCard
          id="sessions"
          title="Sessions"
          description="The sessions it was killed in, newest first, with the time per kill."
          contentClassName="px-0 sm:px-(--card-spacing)"
        >
          {page.sessions.length === 0 ? (
            <p className="px-(--card-spacing) text-sm text-muted-foreground sm:px-0">
              No sessions with kills of it in this range.
            </p>
          ) : (
            <Table className="tabular-nums">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead scope="col">Session</TableHead>
                  <TableHead scope="col" className="text-right">
                    Online
                  </TableHead>
                  <TableHead scope="col" className="text-right">
                    Kills
                  </TableHead>
                  <TableHead scope="col" className="text-right">
                    Per kill
                  </TableHead>
                  {page.gp !== null && (
                    <TableHead scope="col" className="hidden text-right sm:table-cell">
                      Loot
                    </TableHead>
                  )}
                </TableRow>
              </TableHeader>
              <TableBody>
                {page.sessions.map((s) => (
                  <TableRow key={s.id}>
                    <TableHead scope="row" className="font-medium">
                      <Link
                        href={sessionHref(metricsPath, { ...query, measure: 'kills' }, s.id)}
                        className="hover:underline"
                      >
                        {formatInZone(s.start, timezone, MOMENT_OPTIONS)}
                      </Link>
                    </TableHead>
                    <TableCell className="text-right">{formatMs(s.onlineMs)}</TableCell>
                    <TableCell className="text-right">
                      {formatNumber(s.kills)}
                      {s.shared ? '*' : ''}
                    </TableCell>
                    <TableCell className="text-right">
                      {s.msPerKill === null ? '—' : formatMs(s.msPerKill)}
                    </TableCell>
                    {page.gp !== null && (
                      <TableCell className="hidden text-right sm:table-cell">
                        {s.gp === null ? '—' : `${formatGp(s.gp)} gp`}
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {page.sessions.some((s) => s.shared) && (
            <p className="mt-2 px-(--card-spacing) text-xs text-muted-foreground sm:px-0">
              * One hiscores reading covered this session and the ones just before it, so their
              kills are counted together and the time per kill can&apos;t be told.
            </p>
          )}
        </SectionCard>
      )}
    </>
  );
}

function BossTiles({ page }: { page: BossMetricsPage }) {
  const mode = page.mode ? MODE_LABELS[page.mode] : null;
  const tiles: { label: string; value: string; line?: string; muted?: boolean }[] = [
    {
      label: 'Kill count',
      value: page.hiscore ? formatNumber(page.hiscore.score) : 'Not listed',
      muted: !page.hiscore,
      line: page.hiscore
        ? `rank ${formatNumber(page.hiscore.rank)}${
            mode !== null && page.hiscore.modeRank !== null
              ? ` · ${mode} rank ${formatNumber(page.hiscore.modeRank)}`
              : ''
          }`
        : 'the hiscores list most bosses from 5 kills',
    },
    { label: 'Kills in range', value: formatNumber(page.kills) },
    ...(page.gp !== null
      ? [
          {
            label: 'Loot in range',
            value: `${formatGp(page.gp)} gp`,
            line: `${formatNumber(page.drops)} ${page.drops === 1 ? 'drop' : 'drops'}`,
          },
          {
            label: 'Loot per kill',
            value: page.gpPerKill === null ? '—' : `${formatGp(page.gpPerKill)} gp`,
            muted: page.gpPerKill === null,
          },
          {
            label: 'Since the last unique',
            value:
              page.killsSinceUnique === null ? '—' : `${formatNumber(page.killsSinceUnique)} kills`,
            muted: page.killsSinceUnique === null,
            line: page.killsSinceUnique === null ? 'needs a unique with its kill count' : undefined,
          },
        ]
      : []),
  ];
  return (
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      {tiles.map((t) => (
        <div
          key={t.label}
          className="min-w-0 rounded-xl border border-t-2 border-t-metrics-accent bg-card p-3"
        >
          <dt className="text-xs text-muted-foreground">{t.label}</dt>
          <dd
            className={cn(
              'mt-1 truncate text-xl font-semibold tabular-nums',
              t.muted && 'text-base font-normal text-muted-foreground',
            )}
          >
            {t.value}
          </dd>
          {t.line && <dd className="truncate text-xs text-muted-foreground">{t.line}</dd>}
        </div>
      ))}
    </dl>
  );
}

/**
 * The guild's collection log (D-118): the lookup "who has X" (a plain GET form, `?q=`, so it works
 * before the page hydrates and an answer can be sent as a link), the board of every account whose
 * log the viewer may see, and the newest slots across the guild. From @hub/server
 * getGuildCollectionLog, which applies the permission resolver per account.
 */
import { formatNumber, getConfig, type Viewer } from '@hub/core';
import { getDb } from '@hub/db';
import {
  LOOKUP_MAX_LENGTH,
  getGuildCollectionLog,
  getUserSettings,
  lookupQuery,
} from '@hub/server';
import { ChevronLeftIcon, SearchIcon } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Suspense } from 'react';
import { AccountLink } from '@/components/accounts/account-link';
import {
  CollectionLogBoard,
  DAY_OPTIONS,
  SlotIcon,
} from '@/components/collection-log/collection-log';
import { CardSkeleton } from '@/components/common/card-skeleton';
import { SectionCard } from '@/components/common/section-card';
import { ItemIcon } from '@/components/icons/osrs-icon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatInZone } from '@/lib/dates';
import { collectionLogHref } from '@/lib/routes';
import { requireUser } from '@/lib/session';

export function generateMetadata(): Metadata {
  return { title: `Collection log · Guild · ${getConfig().hubName}` };
}

export default async function GuildCollectionLogPage({
  searchParams,
}: PageProps<'/guild/collection-log'>) {
  const { user, viewer } = await requireUser();
  const raw = (await searchParams).q;
  const typed = typeof raw === 'string' ? raw.slice(0, LOOKUP_MAX_LENGTH) : '';
  const query = lookupQuery(typed);
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <Link
          href="/guild"
          className="flex w-fit items-center gap-1 rounded-md text-sm text-muted-foreground hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          <ChevronLeftIcon aria-hidden className="size-4" />
          Guild
        </Link>
        <h1 className="text-3xl leading-tight font-semibold tracking-tight sm:text-4xl">
          Collection log
        </h1>
        <p className="text-sm text-pretty text-muted-foreground">
          Who has logged the most, and who already has the item you need.
        </p>
      </header>
      <search>
        <form action="/guild/collection-log" method="get" role="search" className="flex gap-2">
          <label htmlFor="clog-q" className="sr-only">
            Item
          </label>
          <div className="relative min-w-0 flex-1 sm:max-w-md">
            <SearchIcon
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              id="clog-q"
              name="q"
              type="search"
              defaultValue={typed}
              placeholder="Who has… Tanzanite fang"
              maxLength={LOOKUP_MAX_LENGTH}
              minLength={2}
              autoComplete="off"
              className="pl-9"
            />
          </div>
          <Button type="submit">Look up</Button>
        </form>
      </search>
      <Suspense
        key={query ?? ''}
        fallback={
          <div className="flex flex-col gap-6" role="status" aria-label="Loading the log">
            <CardSkeleton rows={4} />
            <CardSkeleton rows={8} />
          </div>
        }
      >
        <GuildLogContent userId={user.id} viewer={viewer} query={query} />
      </Suspense>
    </div>
  );
}

async function GuildLogContent({
  userId,
  viewer,
  query,
}: {
  userId: string;
  viewer: Viewer;
  query: string | null;
}) {
  const { db } = getDb();
  const { timezone } = await getUserSettings(db, userId);
  const log = await getGuildCollectionLog(db, viewer, { now: new Date(), timezone, query });
  return (
    <>
      {log.lookup && (
        <SectionCard
          id="lookup"
          title={`Who has “${log.lookup.query}”`}
          description={`Among the ${formatNumber(log.searchable)} ${
            log.searchable === 1 ? 'account' : 'accounts'
          } whose events you can see. The hub only knows slots logged since each one was paired.`}
        >
          {log.lookup.items.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nobody has logged an item like that since the hub started watching.
            </p>
          ) : (
            <ul className="flex flex-col divide-y">
              {log.lookup.items.map((item) => (
                <li key={item.item} className="flex flex-col gap-2 py-3 sm:flex-row sm:gap-4">
                  <div className="flex min-w-0 items-center gap-3 sm:w-64 sm:shrink-0">
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-muted/40">
                      <ItemIcon itemId={item.itemId} className="h-7 w-8" holdSpace />
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{item.item}</span>
                      <span className="block text-xs text-muted-foreground tabular-nums">
                        {formatNumber(item.holders.length)} of {formatNumber(log.searchable)}
                      </span>
                    </span>
                  </div>
                  <ul className="flex min-w-0 flex-wrap gap-1.5 sm:pt-1">
                    {item.holders.map((h) => (
                      <li
                        key={h.publicId}
                        className="rounded-full border px-2.5 py-0.5 text-xs tabular-nums"
                        title={`Logged ${formatInZone(h.at, timezone, DAY_OPTIONS)}${
                          h.killCount === null ? '' : ` at kill count ${formatNumber(h.killCount)}`
                        }`}
                      >
                        <AccountLink publicId={h.publicId} name={h.name} />
                        {h.killCount !== null && (
                          <span className="text-muted-foreground">
                            {' '}
                            · {formatNumber(h.killCount)} kc
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      )}
      <div className="grid items-start gap-6 lg:grid-cols-3">
        <SectionCard
          id="board"
          title="Board"
          description="Logged and its rise over 30 days come from the official hiscores; seen by the hub are the new slots its plugin reported."
          className="lg:col-span-2"
          contentClassName="px-0 sm:px-(--card-spacing)"
        >
          {log.board.length === 0 ? (
            <p className="px-(--card-spacing) text-sm text-muted-foreground sm:px-0">
              Nobody&apos;s collection log is shared with you yet.
            </p>
          ) : (
            <CollectionLogBoard rows={log.board} timezone={timezone} />
          )}
        </SectionCard>
        <SectionCard id="recent" title="Newest" description="The newest slots across the guild.">
          {log.recent.length === 0 ? (
            <p className="text-sm text-muted-foreground">No slots yet.</p>
          ) : (
            <ol className="flex flex-col divide-y">
              {log.recent.map((s) => (
                <li
                  key={`${s.account.publicId}:${s.item}`}
                  className="flex items-center gap-3 py-2"
                >
                  <span className="flex size-9 shrink-0 items-center justify-center">
                    <SlotIcon slot={s} className="h-7 w-8" />
                  </span>
                  <span className="min-w-0 flex-1 text-sm">
                    <span className="block truncate font-medium">{s.item}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      <Link
                        href={collectionLogHref(s.account.publicId)}
                        className="hover:text-foreground hover:underline"
                      >
                        {s.account.name}
                      </Link>
                      {' · '}
                      {formatInZone(s.at, timezone, { day: 'numeric', month: 'short' })}
                      {s.killCount !== null && ` · ${formatNumber(s.killCount)} kc`}
                    </span>
                  </span>
                </li>
              ))}
            </ol>
          )}
        </SectionCard>
      </div>
    </>
  );
}

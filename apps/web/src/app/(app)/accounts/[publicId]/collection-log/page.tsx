/**
 * A character's collection log (D-118): the hiscores' "Collections Logged" with its rank as the
 * headline, then the slots the hub saw, grouped by the drop they came with (the shelf, with a search
 * by item or boss), and the newest ones with their kill count beside it. From @hub/server getAccountCollectionLog: the
 * headline needs `hiscores`, the slots `events`; with neither the page is a 404.
 *
 * The checks that answer 404 run before anything streams (NEXT-14).
 */
import { getConfig } from '@hub/core';
import { getDb } from '@hub/db';
import { getAccountCollectionLog, getUserSettings } from '@hub/server';
import { ChevronLeftIcon } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Suspense } from 'react';
import { accountHref } from '@/components/accounts/account-link';
import { CollectionLogList, CollectionLogTiles } from '@/components/collection-log/collection-log';
import { CollectionLogSearch } from '@/components/collection-log/collection-log-search';
import { CardSkeleton } from '@/components/common/card-skeleton';
import { SectionCard } from '@/components/common/section-card';
import { guildCollectionLogHref } from '@/lib/routes';
import { requireUser } from '@/lib/session';
import { loadVisible } from '@/lib/visible-account';

/** Newest slots listed beside the shelf. */
const NEWEST = 10;

export async function generateMetadata({
  params,
}: PageProps<'/accounts/[publicId]/collection-log'>): Promise<Metadata> {
  const { publicId } = await params;
  const visible = await loadVisible(publicId);
  return {
    title: `Collection log · ${visible?.account.name ?? 'Account'} · ${getConfig().hubName}`,
  };
}

export default async function CollectionLogPage({
  params,
}: PageProps<'/accounts/[publicId]/collection-log'>) {
  const { publicId } = await params;
  // See NEXT-14: every 404 before the Suspense boundary.
  const visible = await loadVisible(publicId);
  const categories = visible?.access.categories;
  if (!visible || !(categories!.has('events') || categories!.has('hiscores'))) notFound();
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <Link
          href={accountHref(publicId)}
          className="flex w-fit items-center gap-1 rounded-md text-sm text-muted-foreground hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          <ChevronLeftIcon aria-hidden className="size-4" />
          {visible.account.name}
        </Link>
        <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between sm:gap-6">
          <h1 className="text-3xl leading-tight font-semibold tracking-tight sm:text-4xl">
            Collection log
          </h1>
          <Link
            href={guildCollectionLogHref()}
            className="w-fit text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            The guild&apos;s log
          </Link>
        </div>
      </header>
      <Suspense
        fallback={
          <div className="flex flex-col gap-6" role="status" aria-label="Loading the log">
            <CardSkeleton rows={1} />
            <CardSkeleton rows={6} />
          </div>
        }
      >
        <LogContent publicId={publicId} />
      </Suspense>
    </div>
  );
}

async function LogContent({ publicId }: { publicId: string }) {
  const { user, viewer } = await requireUser();
  const { db } = getDb();
  const { timezone } = await getUserSettings(db, user.id);
  const log = await getAccountCollectionLog(db, viewer, publicId, { now: new Date(), timezone });
  if (!log) notFound();
  const hasNewest = log.slots !== null && log.slots.length > 0;
  const shelf = log.groups !== null && (
    <SectionCard
      id="shelf"
      title="By source"
      description="Slots the hub saw since RuneLite was paired, by the drop they came with. The number is the kill count."
      className={hasNewest ? 'lg:col-span-2' : 'lg:col-span-3'}
    >
      {log.groups.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No new slots yet. Each slot logged from now on shows up here, with the kill count it took.
        </p>
      ) : (
        <CollectionLogSearch groups={log.groups} timezone={timezone} />
      )}
    </SectionCard>
  );
  const newest = hasNewest && (
    <SectionCard
      id="newest"
      title="Newest"
      description="The newest slots and the kill count each took."
    >
      <CollectionLogList slots={log.slots!.slice(0, NEWEST)} timezone={timezone} compact />
    </SectionCard>
  );
  return (
    <>
      <CollectionLogTiles total={log.total} slots={log.slots} timezone={timezone} />
      {(shelf || newest) && (
        <div className="grid items-start gap-6 lg:grid-cols-3">
          {shelf}
          {newest}
        </div>
      )}
      {log.slots === null && (
        <p className="text-sm text-muted-foreground">
          The owner doesn&apos;t share this account&apos;s events with you, so only the total from
          the hiscores is shown.
        </p>
      )}
    </>
  );
}

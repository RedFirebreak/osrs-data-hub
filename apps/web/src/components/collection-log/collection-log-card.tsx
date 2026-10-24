/**
 * The collection log on the character page (D-118): the whole log's count from the hiscores and the
 * newest slots the hub saw, with a link to the character's log page. Loads on its own behind a
 * Suspense boundary; renders nothing when the viewer may see neither `events` nor `hiscores`.
 */
import { formatNumber, type Viewer } from '@hub/core';
import { getDb } from '@hub/db';
import { getAccountCollectionLog } from '@hub/server';
import { ChevronRightIcon } from 'lucide-react';
import Link from 'next/link';
import { SectionCard } from '@/components/common/section-card';
import { collectionLogHref } from '@/lib/routes';
import { CollectionLogList } from './collection-log';

/** Newest slots on the card. */
const CARD_SLOTS = 5;

export async function CollectionLogCard({
  viewer,
  publicId,
  timezone,
}: {
  viewer: Viewer;
  publicId: string;
  timezone: string;
}) {
  const log = await getAccountCollectionLog(getDb().db, viewer, publicId, {
    now: new Date(),
    timezone,
  });
  if (!log) return null;
  const total = log.total?.score ?? null;
  const parts = [
    total === null ? null : `${formatNumber(total)} logged`,
    log.slots === null ? null : `${formatNumber(log.slots.length)} seen by the hub`,
  ].filter(Boolean);
  return (
    <SectionCard
      id="collection-log"
      title="Collection log"
      description={parts.length > 0 ? parts.join(' · ') : undefined}
      action={
        <Link
          href={collectionLogHref(publicId)}
          className="flex items-center gap-0.5 rounded-md text-sm text-muted-foreground hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          See the log
          <ChevronRightIcon aria-hidden className="size-4" />
        </Link>
      }
    >
      {log.slots === null ? null : log.slots.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No new slots since RuneLite was paired. The next one shows up here with its kill count.
        </p>
      ) : (
        <CollectionLogList slots={log.slots.slice(0, CARD_SLOTS)} timezone={timezone} compact />
      )}
    </SectionCard>
  );
}

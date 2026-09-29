'use client';
/**
 * An events timeline that keeps itself current: the server-rendered first page, "load more" through
 * GET /api/app/feed?before=<oldest seq>, optional type filter chips (a filter change reloads the first
 * page from the feed), and live events from the LiveProvider prepended as they arrive (the stream has
 * already applied the viewer's permissions and redaction). Used by the account page (one account) and
 * the guild page (every account the viewer can see).
 *
 *   <EventTimeline initial={page.recentEvents.data} pageSize={20} accountPublicId={publicId}
 *                  typeOptions={eventTypeOptions()} now={now} linkAccounts={false} />
 */
import type { GuildFeedFilter } from '@hub/core';
import type { FeedEvent } from '@hub/server';
import { LoaderCircleIcon } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { EventFeed } from '@/components/events/event-feed';
import { useLiveSubscription } from '@/components/live/live-provider';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { EventTypeOption } from './event-types';
import {
  feedUrl,
  matchesFilter,
  mergeEvents,
  oldestSeq,
  type TimelineFilter,
} from './timeline-model';

export interface EventTimelineProps {
  /** The first page, newest first (server-rendered). */
  initial: readonly FeedEvent[];
  /** Page size of the first page and of each "load more". */
  pageSize: number;
  /** Only this account's events; omit for every visible account. */
  accountPublicId?: string;
  /**
   * The guild feed's admin filter (D-81): live events that fail it are not added. The server
   * applies it to every page without `accountPublicId`, so only the guild page passes it.
   */
  guildFilter?: GuildFeedFilter;
  /** Filter chips; omit for no filter. */
  typeOptions?: readonly EventTypeOption[];
  /** Server render time (ISO), for relative times. */
  now: string;
  /** Link each line to its account page (off on the account's own page). */
  linkAccounts?: boolean;
  /** Accessible name of the list. */
  label: string;
  /** Shown when there are no events at all (no filter). */
  empty: React.ReactNode;
  className?: string;
}

interface FeedResponse {
  events?: FeedEvent[];
  nextBefore?: number | null;
  error?: { message?: string };
}

export function EventTimeline({
  initial,
  pageSize,
  accountPublicId,
  guildFilter,
  typeOptions,
  now,
  linkAccounts = true,
  label,
  empty,
  className,
}: EventTimelineProps) {
  const [types, setTypes] = useState<readonly string[]>([]);
  const [events, setEvents] = useState<readonly FeedEvent[]>(initial);
  const [hasMore, setHasMore] = useState(initial.length >= pageSize);
  const [loading, setLoading] = useState<'more' | 'filter' | null>(null);
  // Only the newest request may apply its result (a quick second filter change wins).
  const latest = useRef(0);
  // The types of the events the list shows (the last filter that loaded; `types` runs ahead of it
  // while a filter change loads).
  const shownTypes = useRef<readonly string[]>([]);
  const filter: TimelineFilter = { accountPublicId, types, guildFilter };

  useLiveSubscription('event', (msg) => {
    if (matchesFilter(msg.event, filter)) setEvents((list) => mergeEvents(list, [msg.event]));
  });

  /**
   * Loads a page: `before` undefined = the first page of a new filter (replaces the list), else the
   * next older page (appended). When a filter change fails, the chips go back to the filter the list
   * still shows, so chips, list, live events and "load more" never disagree.
   */
  async function load(next: TimelineFilter, before: number | undefined): Promise<void> {
    const id = ++latest.current;
    const isFilterChange = before === undefined;
    setLoading(isFilterChange ? 'filter' : 'more');
    const fail = (message: string) => {
      toast.error(message);
      if (isFilterChange) setTypes(shownTypes.current);
    };
    try {
      const res = await fetch(feedUrl(next, { before, limit: pageSize }), {
        credentials: 'same-origin',
      });
      const body = (await res.json().catch(() => null)) as FeedResponse | null;
      if (id !== latest.current) return;
      if (!res.ok || !body?.events) {
        fail(body?.error?.message ?? "Events couldn't be loaded. Try again in a moment.");
        return;
      }
      const page = body.events;
      if (isFilterChange) shownTypes.current = next.types;
      setEvents((list) => (isFilterChange ? page : mergeEvents(list, page)));
      setHasMore(body.nextBefore !== null && body.nextBefore !== undefined);
    } catch {
      if (id === latest.current) {
        fail("Events couldn't be loaded. Check your connection and try again.");
      }
    } finally {
      if (id === latest.current) setLoading(null);
    }
  }

  function toggleType(type: string | null): void {
    const set = new Set(types);
    if (type === null) set.clear();
    else if (set.has(type)) set.delete(type);
    else set.add(type);
    const nextTypes = (typeOptions ?? []).map((o) => o.value).filter((v) => set.has(v));
    setTypes(nextTypes);
    void load({ accountPublicId, types: nextTypes, guildFilter }, undefined);
  }

  const filtered = types.length > 0;
  return (
    <div className={cn('flex flex-col gap-3', className)}>
      {typeOptions && typeOptions.length > 0 && (
        <div role="group" aria-label="Filter events by type" className="flex flex-wrap gap-1.5">
          <Chip pressed={!filtered} onClick={() => toggleType(null)}>
            All
          </Chip>
          {typeOptions.map((o) => (
            <Chip
              key={o.value}
              pressed={types.includes(o.value)}
              onClick={() => toggleType(o.value)}
            >
              {o.label}
            </Chip>
          ))}
        </div>
      )}
      <div
        aria-busy={loading === 'filter' || undefined}
        className={cn('transition-opacity', loading === 'filter' && 'opacity-50')}
      >
        <EventFeed
          events={events}
          now={now}
          linkAccounts={linkAccounts}
          label={label}
          empty={
            filtered ? (
              <p className="py-4 text-sm text-muted-foreground">
                No events of the selected types yet. Choose other types or All.
              </p>
            ) : (
              empty
            )
          }
        />
      </div>
      {hasMore && events.length > 0 && (
        <Button
          variant="outline"
          className="self-center"
          disabled={loading !== null}
          onClick={() => void load(filter, oldestSeq(events))}
        >
          {loading === 'more' && (
            <LoaderCircleIcon aria-hidden data-icon="inline-start" className="animate-spin" />
          )}
          Load more
        </Button>
      )}
    </div>
  );
}

function Chip({
  pressed,
  onClick,
  children,
}: {
  pressed: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        'inline-flex h-7 items-center rounded-full border px-3 text-xs font-medium transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
        pressed
          ? 'border-foreground/20 bg-foreground text-background'
          : 'bg-background text-muted-foreground hover:bg-muted hover:text-foreground',
      )}
    >
      {children}
    </button>
  );
}

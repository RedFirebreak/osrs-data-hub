/**
 * A list of events (FeedEvent from @hub/server: already permission-checked and redacted for the
 * viewer, with describeEvent's line and icon hint). Each row: icon (the game icon of the item or
 * skill it names, else the hint's lucide icon; D-95), the line (linking to the account
 * page unless `linkAccounts` is false), a relative time, a value badge for loot, and a "Special world"
 * badge when flagged.
 *
 * No hooks and no server-only imports: render it from server components (pass `now`, the render time,
 * so relative times hydrate cleanly) or from client components (e.g. prepending live events from
 * useLiveSubscription('event', …)).
 *
 *   <EventFeed events={card.recentEvents} now={now} compact linkAccounts={false} />
 */
import { formatGp, isLootEvent } from '@hub/core';
import type { FeedEvent } from '@hub/server';
import Link from 'next/link';
import { stackTone } from '@/components/account/items';
import { accountHref } from '@/components/accounts/account-link';
import { SpecialWorldBadge } from '@/components/accounts/special-world-badge';
import { RelativeTime } from '@/components/time/relative-time';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { EventIconBadge } from './event-icon';

/**
 * The loot value to badge, or null (no value, zero, or not a loot event: a death's valueGp is the
 * value lost, already in its line).
 */
export function lootValue(event: Pick<FeedEvent, 'type' | 'valueGp'>): number | null {
  const v = event.valueGp;
  return isLootEvent(event.type) && v !== null && Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * The in-game coin stack colours: yellow below 100K, white from 100K, green from 10M (readable in
 * both themes), in the shades for a filled badge.
 */
export function valueTone(value: number): string {
  return stackTone(value, true);
}

export interface EventFeedProps {
  events: readonly FeedEvent[];
  /** Render time from the server (ISO), for hydration-stable relative times. */
  now?: string;
  /** Link each line to its account page (default true; turn off inside that account's own view). */
  linkAccounts?: boolean;
  /** Tighter rows without dividers (cards). */
  compact?: boolean;
  /** Shown instead of the list when there are no events. */
  empty?: React.ReactNode;
  /** Accessible name of the list. */
  label?: string;
  className?: string;
}

export function EventFeed({
  events,
  now,
  linkAccounts = true,
  compact = false,
  empty,
  label = 'Events',
  className,
}: EventFeedProps) {
  if (events.length === 0) {
    return (
      empty ?? <p className={cn('text-sm text-muted-foreground', className)}>No events yet.</p>
    );
  }
  return (
    <ol
      aria-label={label}
      className={cn('flex flex-col', compact ? 'gap-1' : 'divide-y divide-border', className)}
    >
      {events.map((event) => (
        <li key={event.id}>
          <EventFeedItem event={event} now={now} linkAccount={linkAccounts} compact={compact} />
        </li>
      ))}
    </ol>
  );
}

export interface EventFeedItemProps {
  event: FeedEvent;
  now?: string;
  linkAccount?: boolean;
  compact?: boolean;
  className?: string;
}

/** One event row (also usable on its own, e.g. for a "latest event" highlight). */
export function EventFeedItem({
  event,
  now,
  linkAccount = true,
  compact = false,
  className,
}: EventFeedItemProps) {
  const value = lootValue(event);
  return (
    <div className={cn('flex items-start gap-3', compact ? 'py-1.5' : 'py-3', className)}>
      <EventIconBadge
        icon={event.icon}
        label={event.title}
        game={event}
        className={compact ? 'size-7' : undefined}
      />
      <div className="min-w-0 flex-1">
        <p className="text-sm leading-snug break-words">
          {linkAccount ? (
            <Link
              href={accountHref(event.account.publicId)}
              className="underline-offset-4 hover:underline focus-visible:underline"
            >
              {event.line}
            </Link>
          ) : (
            event.line
          )}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <RelativeTime date={event.occurredAt} now={now} />
          {value !== null && (
            <Badge variant="secondary" className={cn('tabular-nums', valueTone(value))}>
              {formatGp(value)} gp
            </Badge>
          )}
          {event.specialWorld && <SpecialWorldBadge />}
        </div>
      </div>
    </div>
  );
}

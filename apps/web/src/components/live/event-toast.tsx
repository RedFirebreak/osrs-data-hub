'use client';
/**
 * The live event toast (handoff §11): the event's icon, its line ("Zezima received Dragon warhammer
 * (38.2M) from Lizardman shaman") linking to the account page, and — when the event is a minute old
 * or older (the plugin's retry queue delivers up to ~10 min late) — how long ago it happened. Stacked
 * by the root layout's <Toaster position="top-right">. The toast id is the event id, so an event
 * that somehow arrives twice updates its toast instead of stacking a second one.
 */
import { relativeTime } from '@hub/core';
import type { FeedEvent } from '@hub/server';
import Link from 'next/link';
import { toast } from 'sonner';
import { accountHref } from '@/components/accounts/account-link';
import { EventIcon } from '@/components/events/event-icon';
import { toastShowsAge } from './live-state';

/** How long an event toast stays (ms). */
export const EVENT_TOAST_DURATION_MS = 8_000;

/** Shows the toast for one event (already permission-checked and filtered by the server). */
export function showEventToast(event: FeedEvent, now: number = Date.now()): void {
  const age = toastShowsAge(event.occurredAt, now)
    ? relativeTime(new Date(event.occurredAt), new Date(now))
    : null;
  toast(
    <Link
      href={accountHref(event.account.publicId)}
      className="underline-offset-4 hover:underline focus-visible:underline"
    >
      {event.line}
    </Link>,
    {
      id: `event-${event.id}`,
      icon: <EventIcon icon={event.icon} className="size-4" />,
      description: age ? <time dateTime={event.occurredAt}>{age}</time> : undefined,
      duration: EVENT_TOAST_DURATION_MS,
    },
  );
}

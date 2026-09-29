'use client';
/**
 * The guild's "Online now" strip (handoff §12 dashboard): the server-rendered list (getDashboard's
 * onlineNow: every visible account whose activity the viewer may see) kept current by live
 * 'presence' messages — accounts come online, go offline, or expire client-side after the message's
 * onlineForMs (mergeOnlineNow in live-state.ts).
 *
 *   <OnlineNow initial={dashboard.onlineNow} />
 */
import type { OnlineEntry } from '@hub/server';
import Link from 'next/link';
import { useMemo } from 'react';
import { accountHref } from '@/components/accounts/account-link';
import { AccountTypeBadge } from '@/components/accounts/account-type-badge';
import { OnlineDot } from '@/components/accounts/online-dot';
import { cn } from '@/lib/utils';
import { useLivePresenceMap } from './live-provider';
import { mergeOnlineNow } from './live-state';

export interface OnlineNowProps {
  initial: readonly OnlineEntry[];
  className?: string;
}

export function OnlineNow({ initial, className }: OnlineNowProps) {
  const live = useLivePresenceMap();
  const rows = useMemo(() => mergeOnlineNow(initial, live), [initial, live]);
  return (
    <section
      aria-labelledby="online-now-heading"
      className={cn(
        'rounded-xl bg-card p-4 text-card-foreground ring-1 ring-foreground/10',
        className,
      )}
    >
      <div className="flex items-baseline justify-between gap-2">
        <h2 id="online-now-heading" className="flex items-center gap-2 text-sm font-medium">
          <OnlineDot online={rows.length > 0} label="" pulse={false} />
          Online now
        </h2>
        <span className="text-xs text-muted-foreground" aria-live="polite">
          {rows.length === 0 ? 'nobody' : `${rows.length} online`}
        </span>
      </div>
      {rows.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">
          Nobody in the guild is playing right now. Accounts show up here as soon as they log in.
        </p>
      ) : (
        <ul className="mt-3 flex flex-wrap gap-2">
          {rows.map((row) => (
            <li key={row.publicId}>
              <Link
                href={accountHref(row.publicId)}
                className="inline-flex max-w-full items-center gap-2 rounded-full border bg-background px-3 py-1 text-sm transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
              >
                <OnlineDot online pulse={false} label="" />
                <span className="truncate font-medium">{row.name}</span>
                <AccountTypeBadge accountType={row.accountType} compact />
                {row.world !== null && (
                  <span
                    className={cn(
                      'text-xs tabular-nums',
                      row.specialWorld
                        ? 'text-violet-700 dark:text-violet-300'
                        : 'text-muted-foreground',
                    )}
                    title={row.specialWorld ? 'Special world' : undefined}
                  >
                    <span aria-hidden>W{row.world}</span>
                    <span className="sr-only">
                      World {row.world}
                      {row.specialWorld ? ' (special world)' : ''}
                    </span>
                  </span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

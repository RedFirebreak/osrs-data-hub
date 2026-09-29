/**
 * The dashboard card for one of the viewer's own accounts (@hub/server AccountCard, handoff §12):
 * name and type, live presence, total level, overall XP, gains today and over 7 days, the last five
 * events, and a link to the account page. Stats the plugin never sent show "Not shared" (D-4).
 * Server-renderable (its live parts are client components).
 *
 *   <AccountCard card={card} now={now} />
 */
import { formatGain, formatNumber } from '@hub/core';
import type { AccountCard as AccountCardData } from '@hub/server';
import { ArrowRightIcon } from 'lucide-react';
import Link from 'next/link';
import { EventFeed } from '@/components/events/event-feed';
import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { accountHref } from './account-link';
import { AccountPresence } from './account-presence';
import { AccountTypeBadge } from './account-type-badge';
import { NotSharedBadge } from './not-shared-badge';

export interface AccountCardProps {
  card: AccountCardData;
  /** Server render time (ISO), for relative times. */
  now: string;
  className?: string;
}

function Stat({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          'truncate text-base font-semibold tabular-nums',
          muted && 'font-normal text-muted-foreground',
        )}
      >
        {value}
      </dd>
    </div>
  );
}

export function AccountCard({ card, now, className }: AccountCardProps) {
  const href = accountHref(card.publicId);
  const hasStats = card.totalLevel !== null || card.overallXp !== null;
  const today = card.gains.today;
  const week = card.gains.week;
  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="flex min-w-0 flex-wrap items-center gap-2">
          <Link
            href={href}
            className="truncate text-lg font-semibold underline-offset-4 hover:underline"
          >
            {card.name}
          </Link>
          <AccountTypeBadge accountType={card.accountType} />
        </CardTitle>
        <CardAction>
          {card.relation === 'contributor' ? (
            <Badge variant="secondary">Contributor</Badge>
          ) : (
            <Badge variant="outline">Owner</Badge>
          )}
        </CardAction>
        <CardDescription>
          <AccountPresence publicId={card.publicId} presence={card.presence} now={now} />
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {hasStats ? (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
            <Stat label="Total level" value={formatNumber(card.totalLevel)} />
            <Stat label="Overall XP" value={formatNumber(card.overallXp)} />
            <Stat
              label="XP today"
              value={today === null ? '—' : formatGain(today)}
              muted={!today}
            />
            <Stat label="XP 7 days" value={week === null ? '—' : formatGain(week)} muted={!week} />
          </dl>
        ) : (
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <span>Stats</span>
            <NotSharedBadge what="stats" />
          </div>
        )}
        <section aria-label={`Recent events of ${card.name}`}>
          <h3 className="mb-1 text-xs font-medium text-muted-foreground">Recent events</h3>
          <EventFeed
            events={card.recentEvents}
            now={now}
            compact
            linkAccounts={false}
            label={`Recent events of ${card.name}`}
            empty={
              <p className="text-sm text-muted-foreground">
                No events yet. Loot, level-ups and other events appear here as the plugin sends
                them.
              </p>
            }
          />
        </section>
      </CardContent>
      <CardFooter className="mt-auto">
        <Link
          href={href}
          className="inline-flex items-center gap-1 text-sm font-medium underline-offset-4 hover:underline"
        >
          View account
          <ArrowRightIcon aria-hidden className="size-4" />
        </Link>
      </CardFooter>
    </Card>
  );
}

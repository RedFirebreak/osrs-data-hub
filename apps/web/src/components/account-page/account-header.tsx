/**
 * The top of the account page (handoff §12): the account's name (the page's h1), its type badge, the
 * viewer's relation to it, live presence (online dot + world, or "last seen"; hidden without the
 * activity category, D-50), the owner, previous names and when the hub first saw it. Server component
 * (AccountPresence is a client component that follows live presence messages).
 */
import type { AccountHeader as Header, Presence, Section } from '@hub/server';
import { EyeOffIcon, UserRoundIcon } from 'lucide-react';
import { AccountPresence } from '@/components/accounts/account-presence';
import { AccountTypeBadge } from '@/components/accounts/account-type-badge';
import { UserAvatar } from '@/components/common/user-avatar';
import { Badge } from '@/components/ui/badge';
import { formatInZone } from '@/lib/dates';

/** Previous names listed before "and N more". */
const NAMES_SHOWN = 5;

export interface AccountHeaderProps {
  account: Header;
  presence: Section<Presence>;
  /** Server render time (ISO). */
  now: string;
  /** The viewer's time zone (Settings), for the dates shown. */
  timezone: string;
}

function relationBadge(account: Header) {
  if (account.relation === 'owner') return <Badge variant="outline">Your account</Badge>;
  if (account.relation === 'contributor') return <Badge variant="secondary">You play this</Badge>;
  if (account.canManage) return <Badge variant="secondary">Admin</Badge>;
  return null;
}

export function AccountHeader({ account, presence, now, timezone }: AccountHeaderProps) {
  const names = account.previousNames;
  const firstSeen = formatInZone(account.firstSeen, timezone, { month: 'long', year: 'numeric' });
  return (
    <header className="flex flex-col gap-3">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="min-w-0 text-2xl font-semibold tracking-tight break-words">
          {account.name}
        </h1>
        <AccountTypeBadge accountType={account.accountType} />
        {relationBadge(account)}
        {account.hidden && (
          <Badge
            variant="outline"
            className="border-amber-500/40 text-amber-700 dark:text-amber-300"
            title="Its owner left the guild without handing it over; only admins can see it."
          >
            <EyeOffIcon aria-hidden data-icon="inline-start" />
            Hidden
          </Badge>
        )}
      </div>
      <AccountPresence publicId={account.publicId} presence={presence} now={now} />
      <dl className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-muted-foreground">
        <div className="flex items-center gap-2">
          <dt className="sr-only">Owner</dt>
          <dd className="flex items-center gap-2">
            {account.owner ? (
              <>
                <UserAvatar name={account.owner.name} image={account.owner.image} size="sm" />
                <span>
                  Owned by <span className="font-medium text-foreground">{account.owner.name}</span>
                </span>
              </>
            ) : (
              <>
                <UserRoundIcon aria-hidden className="size-4" />
                <span>No owner yet: a player of this account can claim it.</span>
              </>
            )}
          </dd>
        </div>
        {firstSeen && (
          <div>
            <dt className="sr-only">First seen</dt>
            <dd>
              On the hub since{' '}
              <time dateTime={account.firstSeen} className="text-foreground">
                {firstSeen}
              </time>
            </dd>
          </div>
        )}
        {names.length > 0 && (
          <div className="min-w-0">
            <dt className="inline">Previously known as </dt>
            <dd className="inline">
              {names.slice(0, NAMES_SHOWN).map((n, i) => (
                <span key={n.name}>
                  {i > 0 && ', '}
                  <span
                    className="text-foreground"
                    title={`Last seen with this name ${n.lastSeen.slice(0, 10)}`}
                  >
                    {n.name}
                  </span>
                </span>
              ))}
              {names.length > NAMES_SHOWN && (
                <details className="inline [&[open]>summary]:hidden">
                  <summary className="inline cursor-pointer underline-offset-4 hover:underline">
                    {' '}
                    and {names.length - NAMES_SHOWN} more
                  </summary>
                  {names.slice(NAMES_SHOWN).map((n) => (
                    <span key={n.name}>
                      , <span className="text-foreground">{n.name}</span>
                    </span>
                  ))}
                </details>
              )}
            </dd>
          </div>
        )}
      </dl>
    </header>
  );
}

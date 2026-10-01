'use client';
/**
 * The guild page's members (handoff §12): every active member with at least one account the viewer
 * can see, each with those accounts and an online dot. The server-rendered online state is updated
 * by live presence messages (sent only for accounts whose activity the viewer may see); without that
 * category an account shows as offline, never as online.
 */
import type { GuildMember } from '@hub/server';
import { useLivePresenceMap } from '@/components/live/live-provider';
import { AccountLink } from '@/components/accounts/account-link';
import { AccountTypeBadge } from '@/components/accounts/account-type-badge';
import { OnlineDot } from '@/components/accounts/online-dot';
import { UserAvatar } from '@/components/account/user-avatar';

export interface MemberListProps {
  members: readonly GuildMember[];
}

export function MemberList({ members }: MemberListProps) {
  const live = useLivePresenceMap();
  const isOnline = (publicId: string, server: boolean) => live.get(publicId)?.online ?? server;
  const onlineCount = members.reduce(
    (n, m) => n + m.accounts.filter((a) => isOnline(a.publicId, a.online)).length,
    0,
  );
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground" aria-live="polite">
        {onlineCount === 0
          ? 'Nobody is playing right now.'
          : `${onlineCount} ${onlineCount === 1 ? 'account' : 'accounts'} online`}
      </p>
      <ul className="flex flex-col divide-y">
        {members.map((m) => (
          <li key={m.userId} className="flex items-start gap-3 py-2.5">
            <UserAvatar name={m.name} image={m.image} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{m.name}</p>
              <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
                {m.accounts.map((a) => {
                  const online = isOnline(a.publicId, a.online);
                  return (
                    <li key={a.publicId} className="flex min-w-0 items-center gap-1.5 text-sm">
                      <OnlineDot online={online} pulse={false} />
                      <AccountLink
                        publicId={a.publicId}
                        name={a.name}
                        className="truncate font-normal"
                      />
                      <AccountTypeBadge accountType={a.accountType} compact />
                    </li>
                  );
                })}
              </ul>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

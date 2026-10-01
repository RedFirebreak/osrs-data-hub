'use client';
/**
 * An account's presence line — online dot, "Online · World 302" or "Offline · last seen 3 min ago" —
 * that follows live 'presence' messages from the LiveProvider (whichever of the server-rendered state
 * and the live one is newer wins; live "online" expires client-side after onlineForMs).
 *
 * Takes the read models' `Section<Presence>` (AccountCard.presence, AccountPage.presence):
 * - not visible (the viewer lacks the activity category) → renders nothing;
 * - not shared → a "Not shared" badge, until a live message arrives;
 * - shared → the line above.
 *
 *   <AccountPresence publicId={card.publicId} presence={card.presence} now={now} />
 */
import type { Presence, Section } from '@hub/server';
import { RelativeTime } from '@/components/events/relative-time';
import { useLivePresence } from '@/components/live/live-provider';
import { liveIsNewer } from '@/components/live/live-state';
import { cn } from '@/lib/utils';
import { NotSharedBadge } from './not-shared-badge';
import { OnlineDot } from './online-dot';
import { SpecialWorldBadge } from './special-world-badge';

export interface AccountPresenceProps {
  publicId: string;
  presence: Section<Presence>;
  /** Server render time (ISO) for hydration-stable "last seen". */
  now?: string;
  className?: string;
}

interface ShownPresence {
  online: boolean;
  world: number | null;
  specialWorld: boolean;
  lastSeen: string | null;
}

export function AccountPresence({ publicId, presence, now, className }: AccountPresenceProps) {
  const live = useLivePresence(publicId);
  if (!presence.visible) return null;

  const server = presence.shared ? presence.data : null;
  let shown: ShownPresence | null = server;
  if (live && (server === null || liveIsNewer(live, server.lastSeen))) {
    shown = {
      online: live.online,
      world: live.world,
      specialWorld: live.specialWorld,
      lastSeen: live.lastSeen,
    };
  }
  if (shown === null) return <NotSharedBadge what="online status" className={className} />;

  return (
    <span
      className={cn(
        'inline-flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm text-muted-foreground',
        className,
      )}
    >
      <OnlineDot online={shown.online} label="" />
      <span className={cn(shown.online && 'font-medium text-foreground')}>
        {shown.online ? 'Online' : 'Offline'}
      </span>
      {shown.online && shown.world !== null && (
        <span>
          <span aria-hidden>· </span>World {shown.world}
        </span>
      )}
      {!shown.online && shown.lastSeen !== null && (
        <span>
          <span aria-hidden>· </span>
          <RelativeTime date={shown.lastSeen} now={now} prefix="last seen" />
        </span>
      )}
      {shown.online && shown.specialWorld && <SpecialWorldBadge />}
    </span>
  );
}

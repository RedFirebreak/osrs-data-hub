'use client';
/**
 * "Right now" when an admin has the live map linked (D-115, D-144): one centred button to the map in
 * place of the coordinates, stale badge and explanation. It says "Online: see on map" or "Offline: see
 * on map" from the account's presence, following live messages like the header's presence line, and
 * just "See on map" when the viewer can't see presence (no `activity`). Opens in a new tab with ↗,
 * like the top bar's "Map".
 */
import type { Presence, Section } from '@hub/server';
import { ArrowUpRightIcon } from 'lucide-react';
import { useShownPresence } from '@/components/accounts/account-presence';
import { OnlineDot } from '@/components/accounts/online-dot';
import { Button } from '@/components/ui/button';

export interface SeeOnMapButtonProps {
  publicId: string;
  presence: Section<Presence>;
  /** The map's address (mapLinkHref). */
  href: string;
}

export function SeeOnMapButton({ publicId, presence, href }: SeeOnMapButtonProps) {
  const shown = useShownPresence(publicId, presence);
  const online = shown === null ? null : shown.online;
  const label = online === null ? 'See on map' : `${online ? 'Online' : 'Offline'}: see on map`;
  return (
    <div className="flex justify-center">
      <Button asChild variant="outline" size="lg" className="px-4">
        <a href={href} target="_blank" rel="noopener noreferrer">
          {online !== null && <OnlineDot online={online} pulse={false} label="" />}
          {label}
          <ArrowUpRightIcon aria-hidden data-icon="inline-end" />
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      </Button>
    </div>
  );
}

/**
 * The live location as text (the `location_live` category): coordinates, plane, whether the player is
 * on a boat, and a stale marker when no update arrived for over two minutes (D-18). No map (a
 * handoff non-goal). Server component.
 */
import type { LiveLocation } from '@hub/server';
import { AnchorIcon, ClockAlertIcon, MapPinIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

export function LocationContent({ location }: { location: LiveLocation }) {
  return (
    <div className="flex flex-col gap-3">
      <p className="flex flex-wrap items-center gap-2">
        <MapPinIcon aria-hidden className="size-4 text-muted-foreground" />
        <span className="font-mono text-base tabular-nums">
          {location.x}, {location.y}
        </span>
        <span className="text-sm text-muted-foreground">plane {location.plane}</span>
      </p>
      <div className="flex flex-wrap gap-2">
        {location.isOnBoat && (
          <Badge variant="secondary">
            <AnchorIcon aria-hidden data-icon="inline-start" />
            On a boat
          </Badge>
        )}
        {location.stale && (
          <Badge
            variant="outline"
            className="border-amber-500/40 text-amber-700 dark:text-amber-300"
          >
            <ClockAlertIcon aria-hidden data-icon="inline-start" />
            Stale: no update for over 2 minutes
          </Badge>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Game coordinates (x, y) of the player&apos;s tile; inside instances these are the
        template&apos;s real-world coordinates.
      </p>
    </div>
  );
}

/**
 * The signed-in app's header: hub name, the main navigation (with the live map when an admin has
 * linked it, D-115), the live-connection indicator and the avatar menu. A translucent layer the page
 * scrolls under; solid for people who ask for less transparency. Rendered by app/(app)/layout.tsx.
 * On a phone the avatar menu drops its chevron, and with the map linked the hub's mark gives its
 * room to the fourth link, so the bar fits a 360-px screen.
 */
import Link from 'next/link';
import { cn } from '@/lib/utils';
import { HubMark } from './hub-mark';
import { LiveStatusIndicator } from './live-status';
import { MainNav } from './main-nav';
import { UserMenu } from './user-menu';

export interface AppHeaderProps {
  hubName: string;
  user: { name: string; image: string | null; isAdmin: boolean };
  /** Public ids of the viewer's own characters, for the navigation's current section. */
  ownAccountIds: readonly string[];
  /** The live map's address while its link is on (mapLinkHref), else null. */
  mapHref: string | null;
}

export function AppHeader({ hubName, user, ownAccountIds, mapHref }: AppHeaderProps) {
  return (
    <header className="sticky top-0 z-40 border-b bg-background/90 backdrop-blur supports-backdrop-filter:bg-background/75 [@media(prefers-reduced-transparency:reduce)]:bg-background [@media(prefers-reduced-transparency:reduce)]:backdrop-blur-none">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-2 px-4 sm:px-6">
        <Link
          href="/"
          className={cn(
            'mr-1 flex min-w-0 items-center gap-2 rounded-lg font-semibold focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none sm:mr-3',
            // On a phone the four links of a linked map need the mark's room; Home goes to the same place.
            mapHref !== null && 'max-sm:hidden',
          )}
        >
          <HubMark />
          {/* not-sr-only resets white-space, so the truncation sits on an inner span. */}
          <span className="sr-only min-w-0 sm:not-sr-only">
            <span className="block truncate">{hubName}</span>
          </span>
        </Link>
        <MainNav ownAccountIds={ownAccountIds} mapHref={mapHref} />
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <LiveStatusIndicator />
          <UserMenu name={user.name} image={user.image} isAdmin={user.isAdmin} />
        </div>
      </div>
    </header>
  );
}

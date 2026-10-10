/**
 * The signed-in app's header: hub name, the main navigation, the live-connection indicator and the
 * avatar menu. A translucent layer the page scrolls under; solid for people who ask for less
 * transparency. Rendered by app/(app)/layout.tsx.
 */
import Link from 'next/link';
import { HubMark } from './hub-mark';
import { LiveStatusIndicator } from './live-status';
import { MainNav } from './main-nav';
import { UserMenu } from './user-menu';

export interface AppHeaderProps {
  hubName: string;
  user: { name: string; image: string | null; isAdmin: boolean };
  /** Public ids of the viewer's own characters, for the navigation's current section. */
  ownAccountIds: readonly string[];
}

export function AppHeader({ hubName, user, ownAccountIds }: AppHeaderProps) {
  return (
    <header className="sticky top-0 z-40 border-b bg-background/90 backdrop-blur supports-backdrop-filter:bg-background/75 [@media(prefers-reduced-transparency:reduce)]:bg-background [@media(prefers-reduced-transparency:reduce)]:backdrop-blur-none">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-2 px-4 sm:px-6">
        <Link
          href="/"
          className="mr-1 flex min-w-0 items-center gap-2 rounded-lg font-semibold focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none sm:mr-3"
        >
          <HubMark />
          <span className="sr-only truncate sm:not-sr-only">{hubName}</span>
        </Link>
        <MainNav ownAccountIds={ownAccountIds} />
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <LiveStatusIndicator />
          <UserMenu name={user.name} image={user.image} isAdmin={user.isAdmin} />
        </div>
      </div>
    </header>
  );
}

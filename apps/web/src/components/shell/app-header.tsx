/**
 * The signed-in app's header: hub name, main navigation (a menu on phones), the live-connection
 * indicator and the user menu. Rendered by app/(app)/layout.tsx.
 */
import Link from 'next/link';
import { HubMark } from './hub-mark';
import { LiveStatusIndicator } from './live-status';
import { MainNav, MobileNav } from './main-nav';
import { UserMenu } from './user-menu';

export interface AppHeaderProps {
  hubName: string;
  user: { name: string; image: string | null; isAdmin: boolean };
}

export function AppHeader({ hubName, user }: AppHeaderProps) {
  return (
    <header className="sticky top-0 z-40 border-b bg-background/90 backdrop-blur supports-backdrop-filter:bg-background/75">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-2 px-4 sm:px-6">
        <MobileNav isAdmin={user.isAdmin} />
        <Link
          href="/"
          className="mr-2 flex min-w-0 items-center gap-2 rounded-lg font-semibold focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          <HubMark />
          <span className="truncate">{hubName}</span>
        </Link>
        <MainNav isAdmin={user.isAdmin} />
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <LiveStatusIndicator />
          <UserMenu name={user.name} image={user.image} isAdmin={user.isAdmin} />
        </div>
      </div>
    </header>
  );
}

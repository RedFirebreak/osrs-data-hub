/**
 * The signed-in part of the hub: every page under (app) needs an active session (requireUser →
 * /login otherwise; each page calls it too, since a layout isn't re-rendered on client navigation).
 * Header with navigation and the user menu, the page in a centred container, and one LiveProvider
 * for toasts, presence and the wizard's live status (handoff §11), inside the icon configuration
 * (OSRS_ICONS_URL and the CDN's stack tables, read here at request time; D-95).
 */
import { getConfig } from '@hub/core';
import Link from 'next/link';
import { IconConfigProvider } from '@/components/icons/icon-config-provider';
import { LiveProvider } from '@/components/live/live-provider';
import { AppHeader } from '@/components/shell/app-header';
import { loadIconConfig } from '@/lib/osrs-icons-server';
import { requireUser } from '@/lib/session';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const [{ user }, icons] = await Promise.all([requireUser(), loadIconConfig()]);
  const { hubName } = getConfig();
  return (
    <IconConfigProvider value={icons}>
      <LiveProvider>
        <a
          href="#main"
          className="sr-only z-50 rounded-md bg-background px-3 py-2 text-sm font-medium shadow focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
        >
          Skip to content
        </a>
        <div className="flex min-h-dvh flex-col">
          <AppHeader
            hubName={hubName}
            user={{ name: user.name, image: user.image, isAdmin: user.isAdmin }}
          />
          <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 sm:py-8">
            {children}
          </main>
          <footer className="border-t">
            <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-2 px-4 py-4 text-xs text-muted-foreground sm:px-6">
              <span>{hubName} · data from the HA Exporter RuneLite plugin</span>
              <Link href="/privacy" className="underline-offset-4 hover:underline">
                Privacy
              </Link>
            </div>
          </footer>
        </div>
      </LiveProvider>
    </IconConfigProvider>
  );
}

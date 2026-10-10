/**
 * Home: the viewer's own character as it is now, the one they played last
 * (components/account-page/character-view.tsx, the character page's body), with the guild's "Online
 * now" strip under it. With more characters the header offers the others. Without any: who is
 * online, and a pointer to the pairing wizard. Live parts update from the LiveProvider; the rest
 * refreshes every minute.
 */
import { getConfig, type Viewer } from '@hub/core';
import { getDb } from '@hub/db';
import { getOnlineNow } from '@hub/server';
import { PlugZapIcon, PlusIcon } from 'lucide-react';
import type { Metadata, Route } from 'next';
import Link from 'next/link';
import { Suspense } from 'react';
import { AccountSkeleton } from '@/components/account-page/account-skeleton';
import { CharacterView } from '@/components/account-page/character-view';
import { StatusIcon } from '@/components/common/status-page';
import { OnlineNow } from '@/components/live/online-now';
import { AutoRefresh } from '@/components/shell/auto-refresh';
import { PageHeader } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { loadOwnAccounts } from '@/lib/own-accounts';
import { requireUser } from '@/lib/session';

export function generateMetadata(): Metadata {
  return { title: `Home · ${getConfig().hubName}` };
}

const WIZARD = '/onboarding' satisfies Route;

export default async function HomePage() {
  const { user, viewer } = await requireUser();
  const [latest] = await loadOwnAccounts();
  if (latest) {
    return (
      <Suspense fallback={<AccountSkeleton />}>
        <CharacterView publicId={latest.publicId} home />
      </Suspense>
    );
  }
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={`Welcome, ${user.name}`} />
      <NoCharacters />
      <Suspense fallback={<Skeleton className="h-24 w-full rounded-xl" />}>
        <GuildOnline viewer={viewer} />
      </Suspense>
      <AutoRefresh />
    </div>
  );
}

async function GuildOnline({ viewer }: { viewer: Viewer }) {
  return <OnlineNow initial={await getOnlineNow(getDb().db, viewer, { now: new Date() })} />;
}

function NoCharacters() {
  return (
    <Card className="items-center px-4 py-10 text-center">
      <StatusIcon icon={PlugZapIcon} />
      <CardHeader className="w-full justify-items-center">
        <CardTitle className="text-lg">
          <h2>Connect RuneLite to see your character</h2>
        </CardTitle>
        <CardDescription className="max-w-prose text-balance">
          Install the HA Exporter plugin, pair it with a 5-digit code and log in to OSRS: your
          skills, XP and loot show up here. It takes about two minutes.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col items-center gap-3">
        <Button asChild size="lg">
          <Link href={WIZARD}>
            <PlusIcon aria-hidden data-icon="inline-start" />
            Add your first device
          </Link>
        </Button>
        <p className="max-w-prose text-xs text-muted-foreground">
          Already paired? Log in to the game with the plugin enabled and your character appears here
          within seconds.
        </p>
      </CardContent>
    </Card>
  );
}

/**
 * Dashboard (handoff §12): the guild's "Online now" strip, then one card per account the viewer owns
 * or contributes to (online dot, world, total level, overall XP, gains today / 7 days, the last five
 * events). Without accounts: a pointer to the pairing wizard. "Today" is cut in the viewer's time zone
 * (Settings). Live parts update from the LiveProvider; the rest refreshes every minute.
 */
import { getConfig, type Viewer } from '@hub/core';
import { getDb } from '@hub/db';
import { getDashboard, getUserSettings } from '@hub/server';
import { PlugZapIcon, PlusIcon } from 'lucide-react';
import type { Metadata, Route } from 'next';
import Link from 'next/link';
import { Suspense } from 'react';
import { AccountCard } from '@/components/accounts/account-card';
import { OnlineNow } from '@/components/live/online-now';
import { AutoRefresh } from '@/components/shell/auto-refresh';
import { PageHeader } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { requireUser } from '@/lib/session';

export function generateMetadata(): Metadata {
  return { title: `Dashboard · ${getConfig().hubName}` };
}

// `as Route`: the wizard belongs to another part of the app (typedRoutes checks literals).
const WIZARD = '/onboarding' as Route;

export default async function DashboardPage() {
  const { user, viewer } = await requireUser();
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Dashboard"
        description={`Welcome back, ${user.name}.`}
        actions={
          <Button asChild variant="outline">
            <Link href={WIZARD}>
              <PlusIcon aria-hidden data-icon="inline-start" />
              Add device
            </Link>
          </Button>
        }
      />
      <Suspense fallback={<DashboardSkeleton />}>
        <DashboardContent userId={user.id} viewer={viewer} />
      </Suspense>
      <AutoRefresh everyMs={60_000} />
    </div>
  );
}

async function DashboardContent({ userId, viewer }: { userId: string; viewer: Viewer }) {
  const { db } = getDb();
  const { timezone } = await getUserSettings(db, userId);
  const renderedAt = new Date();
  const dashboard = await getDashboard(db, viewer, { now: renderedAt, timezone });
  const now = renderedAt.toISOString();
  return (
    <>
      <OnlineNow initial={dashboard.onlineNow} />
      {dashboard.accounts.length === 0 ? (
        <EmptyDashboard />
      ) : (
        <section aria-labelledby="your-accounts-heading" className="flex flex-col gap-3">
          <h2 id="your-accounts-heading" className="text-lg font-semibold">
            Your accounts
          </h2>
          <div className="grid items-stretch gap-4 lg:grid-cols-2">
            {dashboard.accounts.map((card) => (
              <AccountCard key={card.publicId} card={card} now={now} />
            ))}
          </div>
        </section>
      )}
    </>
  );
}

function EmptyDashboard() {
  return (
    <Card className="items-center px-4 py-10 text-center">
      <span
        aria-hidden
        className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground"
      >
        <PlugZapIcon className="size-6" />
      </span>
      <CardHeader className="w-full justify-items-center">
        <CardTitle className="text-lg">Connect RuneLite to see your accounts</CardTitle>
        <CardDescription className="max-w-prose text-balance">
          Install the HA Exporter plugin, pair it with a 5-digit code and log in to OSRS: your
          accounts, XP and loot show up here. It takes about two minutes.
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
          Already paired? Log in to the game with the plugin enabled and your account appears here
          within seconds.
        </p>
      </CardContent>
    </Card>
  );
}

function DashboardSkeleton() {
  return (
    <div className="flex flex-col gap-6" role="status" aria-label="Loading your dashboard">
      <Skeleton className="h-24 w-full rounded-xl" />
      <Skeleton className="h-6 w-40" />
      <div className="grid gap-4 lg:grid-cols-2">
        {[0, 1].map((i) => (
          <div key={i} className="flex flex-col gap-4 rounded-xl p-4 ring-1 ring-foreground/10">
            <Skeleton className="h-6 w-1/2" />
            <Skeleton className="h-4 w-1/3" />
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[0, 1, 2, 3].map((j) => (
                <Skeleton key={j} className="h-10" />
              ))}
            </div>
            {[0, 1, 2].map((j) => (
              <Skeleton key={j} className="h-8" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

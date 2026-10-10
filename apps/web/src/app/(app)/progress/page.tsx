/**
 * Progress without a character in the address (the top bar's link): on to the progress of the
 * character the viewer played last. Without any character there is nothing to show yet, and the
 * page says how to get one.
 */
import { getConfig } from '@hub/core';
import { TrendingUpIcon } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { StatusIcon } from '@/components/common/status-page';
import { PageHeader } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { loadOwnAccounts } from '@/lib/own-accounts';
import { progressHref } from '@/lib/routes';

export function generateMetadata(): Metadata {
  return { title: `Progress · ${getConfig().hubName}` };
}

export default async function ProgressIndexPage() {
  const [latest] = await loadOwnAccounts();
  if (latest) redirect(progressHref(latest.publicId));
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Progress" />
      <Card className="items-center px-4 py-10 text-center">
        <StatusIcon icon={TrendingUpIcon} />
        <CardHeader className="w-full justify-items-center">
          <CardTitle className="text-lg">
            <h2>No character to follow yet</h2>
          </CardTitle>
          <CardDescription className="max-w-prose text-balance">
            Once RuneLite is connected and you have played a session, this page shows what you
            gained: XP by skill, loot, boss kills and play time.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild size="lg">
            <Link href="/onboarding">Connect RuneLite</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

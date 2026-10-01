'use client';
/**
 * Wizard step 4 (handoff §6.3): done. Links to the dashboard and shows who sees the account (D-96):
 * its owner gets the account page's sharing controls right here (DoneSharing), since everything is
 * shared with the guild by default; a contributor is told the owner decides; without an account yet,
 * the default in one line. And that the plugin's own settings decide what reaches the hub in the
 * first place (D-4).
 */
import type { DeviceFirstData } from '@hub/server';
import { LayoutDashboardIcon, MonitorSmartphoneIcon, PlusIcon } from 'lucide-react';
import type { Route } from 'next';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { DoneSharing, sharingHref } from './done-sharing';
import { StepHeading } from './step-heading';

export interface DoneStepProps {
  firstData: DeviceFirstData | null;
  onRestart(): void;
  headingRef?: React.Ref<HTMLHeadingElement>;
}

const SHARING_EXPLAINED = '/privacy#sharing' satisfies Route;

export function DoneStep({ firstData, onRestart, headingRef }: DoneStepProps) {
  const account = firstData?.account ?? null;
  return (
    <div className="flex flex-col gap-6">
      <StepHeading
        step={4}
        headingRef={headingRef}
        title={account ? "You're all set" : 'RuneLite is connected'}
        description={
          account
            ? `${account.name} is on your dashboard, and it updates while you play.`
            : 'Log in to OSRS whenever you like: your account shows up on the dashboard within seconds.'
        }
      />

      <div className="flex flex-col gap-2 rounded-xl bg-muted/40 p-4 text-sm ring-1 ring-foreground/10">
        {account && firstData?.role === 'contributor' ? (
          // Only the owner changes sharing; a contributor's panel is read-only.
          <p className="text-pretty">
            {firstData.ownerName
              ? `${firstData.ownerName} owns ${account.name} and decides who in the guild sees it.`
              : `The owner of ${account.name} decides who in the guild sees it.`}{' '}
            <Link href={sharingHref(account)} className="font-medium underline underline-offset-4">
              Who can see {account.name}
            </Link>
          </p>
        ) : account ? (
          <DoneSharing account={account} />
        ) : (
          <p className="text-pretty">
            A new account shares everything with the guild by default; its owner can change that per
            category on the account&apos;s page.{' '}
            <Link href={SHARING_EXPLAINED} className="font-medium underline underline-offset-4">
              Who can see what
            </Link>
          </p>
        )}
        <p className="text-pretty text-muted-foreground">
          Your HA Exporter plugin settings decide what is sent to the hub in the first place: what
          you turn off there never reaches the hub.
        </p>
      </div>

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end">
        <Button type="button" variant="ghost" onClick={onRestart}>
          <PlusIcon aria-hidden data-icon="inline-start" />
          Pair another device
        </Button>
        <Button asChild variant="outline">
          <Link href="/devices">
            <MonitorSmartphoneIcon aria-hidden data-icon="inline-start" />
            Your devices
          </Link>
        </Button>
        <Button asChild size="lg">
          <Link href="/">
            <LayoutDashboardIcon aria-hidden data-icon="inline-start" />
            Go to the dashboard
          </Link>
        </Button>
      </div>
    </div>
  );
}

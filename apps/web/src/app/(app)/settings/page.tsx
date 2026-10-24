/**
 * Settings (handoff §12): the live toast filter and time zone (SettingsForm → PATCH
 * /api/app/settings), who sees each part of a character (the sharing panel, D-52; here since D-122,
 * `?account=<publicId>` picks the character, else the one played last), what decides which data
 * reaches the hub at all (the plugin, D-4), downloading your data (GET /api/app/export, D-79) and
 * deleting it (POST /api/app/me/delete, D-78).
 */
import { DAY_MS, getConfig } from '@hub/core';
import { getDb } from '@hub/db';
import {
  MAX_TOAST_MIN_LOOT_VALUE,
  SELF_DELETE_CONFIRMATION,
  SELF_DELETE_UNDO_DAYS,
  getSharingSettings,
  getUserSettings,
  supportedTimeZones,
} from '@hub/server';
import { ArrowRightIcon } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Suspense } from 'react';
import { CharacterPicker } from '@/components/accounts/character-picker';
import { CardSkeleton } from '@/components/common/card-skeleton';
import { SectionCard } from '@/components/common/section-card';
import { eventTypeOptions } from '@/components/events/event-types';
import { DeleteDataCard } from '@/components/settings/delete-data-card';
import { ExportDataCard } from '@/components/settings/export-data-card';
import { SettingsForm } from '@/components/settings/settings-form';
import { SharingPanel } from '@/components/sharing/sharing-panel';
import { PageHeader } from '@/components/shell/page-header';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { formatInZone } from '@/lib/dates';
import { loadOwnAccounts } from '@/lib/own-accounts';
import { sharingHref } from '@/lib/routes';
import { requireUser } from '@/lib/session';
import { loadVisible } from '@/lib/visible-account';

export function generateMetadata(): Metadata {
  return { title: `Settings · ${getConfig().hubName}` };
}

export default async function SettingsPage(props?: PageProps<'/settings'>) {
  const { user } = await requireUser();
  const settings = await getUserSettings(getDb().db, user.id);
  const search = (await props?.searchParams) ?? {};
  const wanted = typeof search.account === 'string' ? search.account : null;
  const own = await loadOwnAccounts();
  const sharingOf = wanted ?? own[0]?.publicId ?? null;
  const now = new Date();
  // When "Delete my data" pressed now would delete everything (D-78), in the user's time zone.
  const deleteOn = new Date(now.getTime() + SELF_DELETE_UNDO_DAYS * DAY_MS);
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <PageHeader
        title="Settings"
        description="Who sees your characters, live toasts, your time zone, and downloading or deleting your data."
      />
      {sharingOf !== null && (
        <Suspense key={sharingOf} fallback={<CardSkeleton rows={6} rowClassName="h-8 w-full" />}>
          <SharingSection publicId={sharingOf} own={own} now={now.toISOString()} />
        </Suspense>
      )}
      <SettingsForm
        initial={settings}
        eventTypes={eventTypeOptions()}
        timeZones={supportedTimeZones()}
        maxMinLootValue={MAX_TOAST_MIN_LOOT_VALUE}
      />

      <Card>
        <CardHeader>
          <CardTitle>
            <h2>What gets sent to the hub</h2>
          </CardTitle>
          <CardDescription>
            Your HA Exporter plugin settings in RuneLite decide what reaches the hub in the first
            place.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          <p>
            The plugin chooses which sections (inventory, equipment, location) and which events
            (types, tiers, value thresholds) it sends. The hub stores only what arrives and never
            fills gaps from other data: something the plugin doesn&apos;t send shows as{' '}
            <span className="font-medium">Not shared</span>, and no toast is ever made up from a
            snapshot.
          </p>
          <p className="text-muted-foreground">
            Inside the hub, everything that arrives is visible to the guild by default. Account
            owners change this per category under Sharing, above.
          </p>
          <Link
            href="/privacy"
            className="inline-flex w-fit items-center gap-1 font-medium underline-offset-4 hover:underline"
          >
            What the hub stores and for how long
            <ArrowRightIcon aria-hidden className="size-4" />
          </Link>
        </CardContent>
      </Card>

      <ExportDataCard />
      <DeleteDataCard
        undoDays={SELF_DELETE_UNDO_DAYS}
        deleteOnLabel={
          formatInZone(deleteOn, settings.timezone, {
            day: 'numeric',
            month: 'long',
            year: 'numeric',
          }) ?? deleteOn.toISOString().slice(0, 10)
        }
        deleteOnIso={deleteOn.toISOString()}
        confirmationWord={SELF_DELETE_CONFIRMATION}
      />
    </div>
  );
}

/**
 * The sharing panel of one character (`?account=`), for whoever getSharingSettings admits: its
 * owner, its players and admins. Anyone else is told so rather than shown a 404: the address is a
 * settings page, not the account's.
 */
async function SharingSection({
  publicId,
  own,
  now,
}: {
  publicId: string;
  own: Awaited<ReturnType<typeof loadOwnAccounts>>;
  now: string;
}) {
  const { viewer } = await requireUser();
  const visible = await loadVisible(publicId);
  const settings = visible ? await getSharingSettings(getDb().db, viewer, publicId) : null;
  if (!visible || !settings) {
    return (
      <SectionCard
        id="sharing"
        title="Sharing"
        description="You can't change who sees this account. Only its owner, its players and admins can."
      />
    );
  }
  const { account, access } = visible;
  const isOwn = own.some((a) => a.publicId === publicId);
  return (
    <SectionCard
      id="sharing"
      title={isOwn && own.length > 1 ? 'Sharing' : `Sharing of ${account.name}`}
      description={
        settings.canManage
          ? 'Choose who in the guild sees each part of this account.'
          : 'Who in the guild sees each part of this account. Its owner decides.'
      }
      action={
        isOwn && own.length > 1 ? (
          <CharacterPicker
            current={publicId}
            options={own.map((a) => ({ ...a, href: sharingHref(a.publicId) }))}
          />
        ) : undefined
      }
    >
      <SharingPanel
        // A new owner (transfer, claim) remounts the panel with the refreshed settings.
        key={`${account.ownerUserId ?? 'none'}:${settings.canManage}`}
        publicId={publicId}
        initial={settings}
        hasOwner={account.ownerUserId !== null}
        relation={access.relation}
        now={now}
      />
    </SectionCard>
  );
}

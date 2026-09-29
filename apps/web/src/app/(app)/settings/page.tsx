/**
 * Settings (handoff §12): the live toast filter and time zone (SettingsForm → PATCH
 * /api/app/settings), what decides which data reaches the hub at all (the plugin, D-4), and — in M4 —
 * deleting your data.
 */
import { KNOWN_EVENT_TYPES, describeEvent, getConfig } from '@hub/core';
import { getDb } from '@hub/db';
import { MAX_TOAST_MIN_LOOT_VALUE, getUserSettings, supportedTimeZones } from '@hub/server';
import { ArrowRightIcon, Trash2Icon } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { requireUser } from '@/lib/session';
import { SettingsForm } from './settings-form';

export function generateMetadata(): Metadata {
  return { title: `Settings · ${getConfig().hubName}` };
}

/** The toast type choices, labelled with describeEvent's titles ("Loot", "Level up", …). */
function eventTypeOptions(): { value: string; label: string }[] {
  return KNOWN_EVENT_TYPES.map((type) => ({
    value: type,
    label: describeEvent('', {
      type,
      valueGp: null,
      skill: null,
      level: null,
      tier: null,
      points: null,
      data: null,
    }).title,
  }));
}

export default async function SettingsPage() {
  const { user } = await requireUser();
  const settings = await getUserSettings(getDb().db, user.id);
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <PageHeader title="Settings" description="Live toasts, your time zone and your data." />
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
            Inside the hub, stats, events and activity are visible to the guild by default;
            location, equipment and inventory stay private. Account owners change this per account
            on the account page.
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

      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2">
            <h2>Delete my data</h2>
            <Badge variant="secondary">Coming soon</Badge>
          </CardTitle>
          <CardDescription>
            Removes your account from the hub, revokes your devices and deletes the data of accounts
            nobody else plays, with a 7-day undo window. Until it is available, ask an admin.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="destructive" disabled aria-describedby="delete-coming-soon">
            <Trash2Icon aria-hidden data-icon="inline-start" />
            Delete my data
          </Button>
          <p id="delete-coming-soon" className="sr-only">
            Not available yet.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

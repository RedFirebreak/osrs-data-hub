/**
 * Settings (handoff §12): the live toast filter and time zone (SettingsForm → PATCH
 * /api/app/settings), what decides which data reaches the hub at all (the plugin, D-4), downloading
 * your data (GET /api/app/export, D-79) and deleting it (POST /api/app/me/delete, D-78).
 */
import { getConfig } from '@hub/core';
import { getDb } from '@hub/db';
import {
  MAX_TOAST_MIN_LOOT_VALUE,
  SELF_DELETE_UNDO_DAYS,
  getUserSettings,
  supportedTimeZones,
} from '@hub/server';
import { ArrowRightIcon } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { eventTypeOptions } from '@/components/events/event-types';
import { DeleteDataCard } from '@/components/settings/delete-data-card';
import { ExportDataCard } from '@/components/settings/export-data-card';
import { PageHeader } from '@/components/shell/page-header';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { formatInZone } from '@/lib/dates';
import { requireUser } from '@/lib/session';
import { SettingsForm } from './settings-form';

export function generateMetadata(): Metadata {
  return { title: `Settings · ${getConfig().hubName}` };
}

const DAY_MS = 24 * 60 * 60 * 1000;

export default async function SettingsPage() {
  const { user } = await requireUser();
  const settings = await getUserSettings(getDb().db, user.id);
  // When "Delete my data" pressed now would delete everything (D-78), in the user's time zone.
  const now = new Date();
  const deleteOn = new Date(now.getTime() + SELF_DELETE_UNDO_DAYS * DAY_MS);
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <PageHeader
        title="Settings"
        description="Live toasts, your time zone, and downloading or deleting your data."
      />
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
            owners change this per category on the account page.
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
      />
    </div>
  );
}

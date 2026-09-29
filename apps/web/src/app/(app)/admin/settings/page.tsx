/**
 * Admin → Settings: hub-wide options an admin changes here rather than in the environment (stored in
 * hub_settings). Today: the guild activity feed's filter (D-81), a minimum loot value and whether
 * level-ups past 99 are shown.
 */
import { MAX_GUILD_FEED_MIN_LOOT_VALUE } from '@hub/core';
import { getDb } from '@hub/db';
import { getGuildFeedFilter } from '@hub/server';
import type { Metadata } from 'next';
import { AdminSectionHeader } from '@/components/admin/admin-section';
import { GuildFeedForm } from '@/components/admin/guild-feed-form';
import { adminMetadata, requireAdmin } from '@/lib/session';

export function generateMetadata(): Promise<Metadata> {
  return adminMetadata('Settings');
}

export default async function AdminSettingsPage() {
  await requireAdmin();
  const filter = await getGuildFeedFilter(getDb().db);
  return (
    <section aria-labelledby="admin-settings" className="flex flex-col gap-4">
      <AdminSectionHeader
        id="admin-settings"
        title="Settings"
        description="Options for the whole hub. Changes apply at once and are recorded in the audit log."
      />
      <GuildFeedForm initial={filter} maxMinLootValue={MAX_GUILD_FEED_MIN_LOOT_VALUE} />
    </section>
  );
}

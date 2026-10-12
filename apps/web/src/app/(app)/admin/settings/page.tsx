/**
 * Admin → Settings: hub-wide options an admin changes here rather than in the environment (stored in
 * hub_settings): the guild activity feed's filter (D-81), a minimum loot value and whether
 * level-ups past 99 are shown; the live map's link (D-115); and Invite a friend (D-117).
 */
import {
  MAX_FRIENDS_PER_MEMBER,
  MAX_GUILD_FEED_MIN_LOOT_VALUE,
  MIN_FRIENDS_PER_MEMBER,
  getConfig,
} from '@hub/core';
import { getDb } from '@hub/db';
import { getGuildFeedFilter, getInviteFriends, getMapLink } from '@hub/server';
import type { Metadata } from 'next';
import { AdminSectionHeader } from '@/components/admin/admin-section';
import { GuildFeedForm } from '@/components/admin/guild-feed-form';
import { InviteFriendsForm } from '@/components/admin/invite-friends-form';
import { MapLinkForm } from '@/components/admin/map-link-form';
import { adminMetadata, requireAdmin } from '@/lib/session';

export function generateMetadata(): Promise<Metadata> {
  return adminMetadata('Settings');
}

export default async function AdminSettingsPage() {
  await requireAdmin();
  const { db } = getDb();
  const [filter, mapLink, inviteFriends] = await Promise.all([
    getGuildFeedFilter(db),
    getMapLink(db),
    getInviteFriends(db),
  ]);
  return (
    <section aria-labelledby="admin-settings" className="flex flex-col gap-4">
      <AdminSectionHeader
        id="admin-settings"
        title="Settings"
        description="Options for the whole hub. Changes apply at once and are recorded in the audit log."
      />
      <GuildFeedForm initial={filter} maxMinLootValue={MAX_GUILD_FEED_MIN_LOOT_VALUE} />
      <MapLinkForm initial={mapLink} />
      <InviteFriendsForm
        initial={inviteFriends}
        min={MIN_FRIENDS_PER_MEMBER}
        max={MAX_FRIENDS_PER_MEMBER}
        guildName={getConfig().discord.guildName}
      />
    </section>
  );
}

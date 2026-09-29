/**
 * The guild activity feed's filter (D-81): an admin setting in hub_settings under 'guild_feed', read
 * by the guild page and GET /api/app/feed, and changed on Admin → Settings. No row, or a stored
 * value this version can't read, means DEFAULT_GUILD_FEED_FILTER.
 */
import {
  DEFAULT_GUILD_FEED_FILTER,
  MAX_GUILD_FEED_MIN_LOOT_VALUE,
  type GuildFeedFilter,
} from '@hub/core';
import { hubSettings, type Db, type DbOrTx } from '@hub/db';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { audit } from '../audit';

const GUILD_FEED_KEY = 'guild_feed';

/** The filter as the admin page sends it (strict, D-10) and as it is stored. */
export const GuildFeedFilterSchema = z.strictObject({
  minLootValue: z.number().int().min(0).max(MAX_GUILD_FEED_MIN_LOOT_VALUE),
  showVirtualLevels: z.boolean(),
});

/** The stored value, read leniently: unknown keys ignored, missing ones take their default. */
const StoredGuildFeedFilterSchema = z.object(GuildFeedFilterSchema.shape).partial();

/**
 * The current filter. One primary-key read per call, so it isn't cached: the guild page and the
 * feed route read it once per request, and a change shows on the next one.
 */
export async function getGuildFeedFilter(db: DbOrTx): Promise<GuildFeedFilter> {
  const [row] = await db
    .select({ value: hubSettings.value })
    .from(hubSettings)
    .where(eq(hubSettings.key, GUILD_FEED_KEY));
  const parsed = StoredGuildFeedFilterSchema.safeParse(row?.value);
  const stored = parsed.success ? parsed.data : {};
  return {
    minLootValue: stored.minLootValue ?? DEFAULT_GUILD_FEED_FILTER.minLootValue,
    showVirtualLevels: stored.showVirtualLevels ?? DEFAULT_GUILD_FEED_FILTER.showVirtualLevels,
  };
}

/** Stores a new filter (admin only; the caller checks). Audited as 'hub.guild_feed_changed'. */
export async function setGuildFeedFilter(
  db: Db,
  opts: { filter: GuildFeedFilter; actorUserId: string },
): Promise<GuildFeedFilter> {
  const filter = GuildFeedFilterSchema.parse(opts.filter);
  await db.transaction(async (tx) => {
    const now = new Date();
    await tx
      .insert(hubSettings)
      .values({ key: GUILD_FEED_KEY, value: filter, updatedAt: now, updatedBy: opts.actorUserId })
      .onConflictDoUpdate({
        target: hubSettings.key,
        set: { value: filter, updatedAt: now, updatedBy: opts.actorUserId },
      });
    await audit(tx, {
      actorUserId: opts.actorUserId,
      action: 'hub.guild_feed_changed',
      targetType: 'hub',
      targetId: GUILD_FEED_KEY,
      meta: filter,
    });
  });
  return filter;
}

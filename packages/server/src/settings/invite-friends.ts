/**
 * Invite a friend (D-117), the admin's side: whether members may invite friends and how many each
 * may have. In hub_settings under 'invite_friends', changed on Admin → Settings. No row, or a stored
 * value this version can't read, means DEFAULT_INVITE_FRIENDS (on, three friends).
 */
import {
  DEFAULT_INVITE_FRIENDS,
  MAX_FRIENDS_PER_MEMBER,
  MIN_FRIENDS_PER_MEMBER,
  type InviteFriendsSettings,
} from '@hub/core';
import { hubSettings, type Db, type DbOrTx } from '@hub/db';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { audit } from '../audit';

const INVITE_FRIENDS_KEY = 'invite_friends';

const maxPerMember = z
  .number()
  .int()
  .min(MIN_FRIENDS_PER_MEMBER, `At least ${MIN_FRIENDS_PER_MEMBER}`)
  .max(MAX_FRIENDS_PER_MEMBER, `At most ${MAX_FRIENDS_PER_MEMBER}`);

/** The setting as the admin page sends it (strict, D-10). */
export const InviteFriendsSchema = z.strictObject({ enabled: z.boolean(), maxPerMember });

/** The stored value, read leniently: unknown keys ignored, a missing or unusable one the default. */
const StoredInviteFriendsSchema = z
  .object({ enabled: z.boolean().catch(DEFAULT_INVITE_FRIENDS.enabled) })
  .extend({ maxPerMember: maxPerMember.catch(DEFAULT_INVITE_FRIENDS.maxPerMember) })
  .partial();

/** The current setting. One primary-key read per call, so a change applies on the next request. */
export async function getInviteFriends(db: DbOrTx): Promise<InviteFriendsSettings> {
  const [row] = await db
    .select({ value: hubSettings.value })
    .from(hubSettings)
    .where(eq(hubSettings.key, INVITE_FRIENDS_KEY));
  const parsed = StoredInviteFriendsSchema.safeParse(row?.value);
  const stored = parsed.success ? parsed.data : {};
  return {
    enabled: stored.enabled ?? DEFAULT_INVITE_FRIENDS.enabled,
    maxPerMember: stored.maxPerMember ?? DEFAULT_INVITE_FRIENDS.maxPerMember,
  };
}

/** Stores a new setting (admin only; the caller checks). Audited as 'hub.invite_friends_changed'. */
export async function setInviteFriends(
  db: Db,
  opts: { settings: z.input<typeof InviteFriendsSchema>; actorUserId: string },
): Promise<InviteFriendsSettings> {
  const settings = InviteFriendsSchema.parse(opts.settings);
  await db.transaction(async (tx) => {
    const now = new Date();
    await tx
      .insert(hubSettings)
      .values({
        key: INVITE_FRIENDS_KEY,
        value: settings,
        updatedAt: now,
        updatedBy: opts.actorUserId,
      })
      .onConflictDoUpdate({
        target: hubSettings.key,
        set: { value: settings, updatedAt: now, updatedBy: opts.actorUserId },
      });
    await audit(tx, {
      actorUserId: opts.actorUserId,
      action: 'hub.invite_friends_changed',
      targetType: 'hub',
      targetId: INVITE_FRIENDS_KEY,
      meta: settings,
    });
  });
  return settings;
}

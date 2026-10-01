/**
 * GET /members/{discord_id} of the public API (D-100): whether one Discord account is a member of
 * the hub, and an admin. For the guild's own services (the live map), which sign people in with
 * Discord themselves and let the hub decide who may come in.
 */
import { users, type DbOrTx } from '@hub/db';
import { eq } from 'drizzle-orm';
import { ApiError } from './errors';
import type { ApiPrincipal } from './key-auth';
import { isDiscordIdLike } from './params';

export interface ApiMember {
  /** The Discord user id that was asked about. */
  discordId: string;
  /** A hub user with this Discord id exists and is active. */
  member: boolean;
  /** The member's stored admin flag; false for anyone who isn't a member. */
  isAdmin: boolean;
  /** The member's display name; null for anyone who isn't a member. */
  name: string | null;
}

/**
 * The verdict on one Discord id, for a service key; null for a user key, for which the endpoint
 * doesn't exist (the web answers the unknown-path 404, whatever the id looks like). The member
 * directory stays restricted (D-80): one id in, one verdict out.
 *
 * An id no hub user has and a user in grace answer alike (`member: false`, no admin flag, no name),
 * so a service learns nothing about who left. An id that can't be a Discord id is ApiError
 * `invalid`, never a lookup (DB-1).
 */
export async function apiMember(
  db: DbOrTx,
  principal: ApiPrincipal,
  discordId: string,
): Promise<ApiMember | null> {
  if (principal.kind !== 'service') return null;
  if (!isDiscordIdLike(discordId)) {
    throw new ApiError('invalid', 'discord_id must be a Discord user id (15 to 22 digits)');
  }
  const [user] = await db
    .select({ name: users.name, isAdmin: users.isAdmin, status: users.status })
    .from(users)
    .where(eq(users.discordId, discordId));
  if (!user || user.status !== 'active') {
    return { discordId, member: false, isAdmin: false, name: null };
  }
  return { discordId, member: true, isAdmin: user.isAdmin, name: user.name };
}

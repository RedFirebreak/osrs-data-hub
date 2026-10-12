/**
 * Invite a friend (D-117): the invites members hand out by Discord username, and the usernames an
 * admin has barred from being invited.
 */
import { sql } from 'drizzle-orm';
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { users } from './auth';

const tstz = (name: string) => timestamp(name, { withTimezone: true });

/**
 * One invite. `username` is the Discord username it was made for (normalised, lowercase), unique:
 * one friend has one inviter. At the friend's first sign-in `user_id` binds the invite to them, and
 * from then on the invite follows the Discord account, not the name. The inviter going (deleted)
 * takes the invite along; the friend's row going leaves an open invite their inviter can remove.
 */
export const friendInvites = pgTable(
  'friend_invites',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    username: text('username').notNull(),
    invitedByUserId: text('invited_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: tstz('created_at').defaultNow().notNull(),
    /** The friend's first sign-in on this invite. */
    joinedAt: tstz('joined_at'),
  },
  (t) => [
    uniqueIndex('friend_invites_username_uidx').on(t.username),
    uniqueIndex('friend_invites_user_uidx').on(t.userId),
    index('friend_invites_invited_by_idx').on(t.invitedByUserId),
  ],
);

/**
 * Discord usernames nobody may invite. `discord_id` is the account's id when the blacklisted friend
 * had signed in, so a new username doesn't get them past it.
 */
export const friendBlacklist = pgTable(
  'friend_blacklist',
  {
    username: text('username').primaryKey(),
    discordId: text('discord_id'),
    createdAt: tstz('created_at').defaultNow().notNull(),
    createdByUserId: text('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
  },
  (t) => [index('friend_blacklist_discord_id_idx').on(t.discordId)],
);

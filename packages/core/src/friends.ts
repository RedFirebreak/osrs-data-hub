/**
 * Invite a friend (D-117): a member of the guild lets a friend who is not in the Discord guild into
 * the hub by their Discord username. The friend still signs in with Discord; the guild gate lets them
 * through on the invite. Client-safe: the forms validate with the same rules as the server.
 */

/** Whether members may invite, and how many friends each may have. Admin → Settings. */
export interface InviteFriendsSettings {
  /** Off stops new invites; friends already in keep their access. */
  enabled: boolean;
  /** Friends one member may have (invited, signed in or not). */
  maxPerMember: number;
}

export const DEFAULT_INVITE_FRIENDS: InviteFriendsSettings = { enabled: true, maxPerMember: 3 };

/** The range an admin can set the number of friends per member to. */
export const MIN_FRIENDS_PER_MEMBER = 1;
export const MAX_FRIENDS_PER_MEMBER = 25;

/**
 * Discord's username rules since the 2023 change: 2 to 32 characters, lowercase letters, digits,
 * `_` and `.`, and never two dots in a row. The old `name#1234` form is gone for people.
 */
const DISCORD_USERNAME = /^(?!.*\.\.)[a-z0-9_.]{2,32}$/;

/**
 * A Discord username as the hub stores and compares it: trimmed, a leading `@` dropped, lowercase.
 * Null when it can't be a Discord username. Discord returns usernames lowercase, so an invite matches
 * the `username` of the person who signs in exactly.
 */
export function normalizeDiscordUsername(text: string): string | null {
  const name = text.trim().replace(/^@/, '').toLowerCase();
  return DISCORD_USERNAME.test(name) ? name : null;
}

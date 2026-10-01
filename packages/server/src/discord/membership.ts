import type { DiscordVerifyFailureKind } from '../metrics';
import type { DiscordGuildMember, DiscordUser, MemberLookup } from './client';

export interface GuildPolicy {
  guildId: string;
  requiredRoleIds: readonly string[];
  adminRoleIds: readonly string[];
  adminUserIds: readonly string[];
}

export type MembershipVerdict =
  | { kind: 'ok'; member: DiscordGuildMember }
  | { kind: 'not_member' }
  | { kind: 'missing_role' }
  | { kind: 'error'; reason: DiscordVerifyFailureKind };

/** Applies the role policy to a lookup: any-of DISCORD_REQUIRED_ROLE_IDS when set. */
export function evaluateMembership(lookup: MemberLookup, policy: GuildPolicy): MembershipVerdict {
  if (lookup.kind === 'not_member') return { kind: 'not_member' };
  if (lookup.kind === 'error') return { kind: 'error', reason: lookup.reason };
  const roles = lookup.member.roles;
  if (policy.requiredRoleIds.length > 0 && !roles.some((r) => policy.requiredRoleIds.includes(r))) {
    return { kind: 'missing_role' };
  }
  return { kind: 'ok', member: lookup.member };
}

export function isAdmin(
  discordUserId: string,
  roles: readonly string[],
  policy: GuildPolicy,
): boolean {
  return (
    policy.adminUserIds.includes(discordUserId) ||
    roles.some((r) => policy.adminRoleIds.includes(r))
  );
}

/** Display name: guild nick > global name > username. */
export function displayName(user: DiscordUser, member?: DiscordGuildMember | null): string {
  return member?.nick || user.global_name || user.username;
}

/** Avatar URL: guild avatar > user avatar > default avatar. */
export function avatarUrl(
  user: DiscordUser,
  guildId: string,
  member?: DiscordGuildMember | null,
): string {
  if (member?.avatar) {
    const ext = member.avatar.startsWith('a_') ? 'gif' : 'png';
    return `https://cdn.discordapp.com/guilds/${guildId}/users/${user.id}/avatars/${member.avatar}.${ext}`;
  }
  if (user.avatar) {
    const ext = user.avatar.startsWith('a_') ? 'gif' : 'png';
    return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${ext}`;
  }
  return `https://cdn.discordapp.com/embed/avatars/${defaultAvatarIndex(user)}.png`;
}

function defaultAvatarIndex(user: DiscordUser): number {
  try {
    return !user.discriminator || user.discriminator === '0'
      ? Number((BigInt(user.id) >> 22n) % 6n)
      : Number.parseInt(user.discriminator, 10) % 5;
  } catch {
    return 0;
  }
}

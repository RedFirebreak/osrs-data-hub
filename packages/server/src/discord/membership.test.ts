import { describe, expect, it } from 'vitest';
import type { DiscordGuildMember, DiscordUser, MemberLookup } from './client';
import {
  avatarUrl,
  displayName,
  evaluateMembership,
  isAdmin,
  type GuildPolicy,
} from './membership';

const POLICY: GuildPolicy = {
  guildId: '111',
  requiredRoleIds: [],
  adminRoleIds: ['admin-role'],
  adminUserIds: ['999'],
};

const found = (roles: string[]): MemberLookup => ({ kind: 'member', member: { roles } });

describe('evaluateMembership', () => {
  it('passes definitive not-member and errors through', () => {
    expect(evaluateMembership({ kind: 'not_member' }, POLICY)).toEqual({ kind: 'not_member' });
    for (const reason of ['config', 'auth', 'rate_limited', 'unavailable'] as const) {
      expect(evaluateMembership({ kind: 'error', status: 500, code: 1, reason }, POLICY)).toEqual({
        kind: 'error',
        reason,
      });
    }
  });

  it('accepts any member when no role is required', () => {
    const lookup = found([]);
    expect(evaluateMembership(lookup, POLICY)).toEqual({ kind: 'ok', member: { roles: [] } });
  });

  it('requires at least one of the required roles (any-of)', () => {
    const policy = { ...POLICY, requiredRoleIds: ['a', 'b'] };
    expect(evaluateMembership(found(['x', 'b']), policy)).toEqual({
      kind: 'ok',
      member: { roles: ['x', 'b'] },
    });
    expect(evaluateMembership(found(['a']), policy).kind).toBe('ok');
    expect(evaluateMembership(found(['x']), policy)).toEqual({ kind: 'missing_role' });
    expect(evaluateMembership(found([]), policy)).toEqual({ kind: 'missing_role' });
  });
});

describe('isAdmin', () => {
  it('is true for a listed user id or any admin role', () => {
    expect(isAdmin('999', [], POLICY)).toBe(true);
    expect(isAdmin('1', ['x', 'admin-role'], POLICY)).toBe(true);
    expect(isAdmin('1', ['x'], POLICY)).toBe(false);
    expect(isAdmin('999', ['admin-role'], { ...POLICY, adminUserIds: [], adminRoleIds: [] })).toBe(
      false,
    );
  });
});

describe('displayName', () => {
  const user: DiscordUser = { id: '1', username: 'zezima', global_name: 'Zezima' };

  it('prefers the guild nick, then the global name, then the username', () => {
    const member: DiscordGuildMember = { roles: [], nick: 'Zez' };
    expect(displayName(user, member)).toBe('Zez');
    expect(displayName(user, { roles: [], nick: null })).toBe('Zezima');
    expect(displayName(user, { roles: [], nick: '' })).toBe('Zezima');
    expect(displayName(user)).toBe('Zezima');
    expect(displayName({ ...user, global_name: null }, null)).toBe('zezima');
    expect(displayName({ id: '1', username: 'plain' })).toBe('plain');
  });
});

describe('avatarUrl', () => {
  const id = '80351110224678912';
  const base: DiscordUser = { id, username: 'nelly', discriminator: '0' };

  it('uses the guild avatar first, animated as gif', () => {
    const user = { ...base, avatar: 'userhash' };
    expect(avatarUrl(user, '111', { roles: [], avatar: 'guildhash' })).toBe(
      `https://cdn.discordapp.com/guilds/111/users/${id}/avatars/guildhash.png`,
    );
    expect(avatarUrl(user, '111', { roles: [], avatar: 'a_anim' })).toBe(
      `https://cdn.discordapp.com/guilds/111/users/${id}/avatars/a_anim.gif`,
    );
  });

  it('falls back to the user avatar', () => {
    expect(avatarUrl({ ...base, avatar: 'userhash' }, '111', { roles: [], avatar: null })).toBe(
      `https://cdn.discordapp.com/avatars/${id}/userhash.png`,
    );
    expect(avatarUrl({ ...base, avatar: 'a_userhash' }, '111')).toBe(
      `https://cdn.discordapp.com/avatars/${id}/a_userhash.gif`,
    );
  });

  it('computes the default avatar for new usernames and legacy discriminators', () => {
    // New username system: (id >> 22) % 6.
    const expected = Number((BigInt(id) >> 22n) % 6n);
    expect(avatarUrl(base, '111')).toBe(`https://cdn.discordapp.com/embed/avatars/${expected}.png`);
    expect(avatarUrl({ id, username: 'x' }, '111')).toBe(
      `https://cdn.discordapp.com/embed/avatars/${expected}.png`,
    );
    // Legacy discriminator: discriminator % 5.
    expect(avatarUrl({ ...base, discriminator: '1337' }, '111')).toBe(
      'https://cdn.discordapp.com/embed/avatars/2.png',
    );
    // A malformed id never throws.
    expect(avatarUrl({ id: 'not-a-snowflake', username: 'x' }, '111')).toBe(
      'https://cdn.discordapp.com/embed/avatars/0.png',
    );
  });
});

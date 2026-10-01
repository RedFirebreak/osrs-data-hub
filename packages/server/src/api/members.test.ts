/**
 * GET /members/{discord_id} (D-100): a service key asks whether one Discord account is a member of
 * the hub and an admin. Active members answer with their name and admin flag; an unknown id and a
 * user in grace answer alike; a user key gets null (the endpoint doesn't exist for it); a value that
 * can't be a Discord id is refused before any lookup.
 */
import { users } from '@hub/db';
import { createTestDatabase, type TestDatabase } from '@hub/db/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedUser, type SeededUser } from '../accounts/test-support';
import { ApiError } from './errors';
import { authenticateApiKey, type ApiPrincipal } from './key-auth';
import { apiMember } from './members';
import { isDiscordIdLike } from './params';
import { createServiceKey } from './service-keys';
import { makeKey } from './test-support';

let t: TestDatabase;
let admin: SeededUser;
let member: SeededUser;
let leaver: SeededUser;
let service: ApiPrincipal;

const NOW = new Date('2026-10-01T12:00:00Z');
const ADMIN_DISCORD_ID = '100000000000000001';
const MEMBER_DISCORD_ID = '100000000000000002';
const LEAVER_DISCORD_ID = '100000000000000003';
const UNKNOWN_DISCORD_ID = '100000000000000099';

async function serviceKey(categories: string[]): Promise<ApiPrincipal> {
  const created = await createServiceKey(t.db, {
    actor: admin.viewer,
    input: { name: 'Guild live map', categories },
    now: NOW,
  });
  const auth = await authenticateApiKey(t.db, `Bearer ${created.key}`, NOW);
  if (!auth.ok) throw new Error(`service key refused: ${auth.reason}`);
  return auth.principal;
}

async function setDiscordId(user: SeededUser, discordId: string): Promise<void> {
  await t.db.update(users).set({ discordId }).where(eq(users.id, user.id));
}

beforeAll(async () => {
  t = await createTestDatabase('api-members');
  admin = await seedUser(t.db, { name: 'Ada Admin', isAdmin: true });
  member = await seedUser(t.db, { name: 'Molly Member' });
  // An admin in grace: neither the membership nor the admin flag may show.
  leaver = await seedUser(t.db, { name: 'Lenny Leaver', isAdmin: true, status: 'grace' });
  await setDiscordId(admin, ADMIN_DISCORD_ID);
  await setDiscordId(member, MEMBER_DISCORD_ID);
  await setDiscordId(leaver, LEAVER_DISCORD_ID);
  service = await serviceKey(['activity', 'location_live']);
});

afterAll(async () => {
  await t.drop();
});

describe('apiMember with a service key', () => {
  it('answers an active member with their display name and stored admin flag', async () => {
    expect(await apiMember(t.db, service, MEMBER_DISCORD_ID)).toEqual({
      discordId: MEMBER_DISCORD_ID,
      member: true,
      isAdmin: false,
      name: 'Molly Member',
    });
    expect(await apiMember(t.db, service, ADMIN_DISCORD_ID)).toEqual({
      discordId: ADMIN_DISCORD_ID,
      member: true,
      isAdmin: true,
      name: 'Ada Admin',
    });
  });

  it('answers an unknown id and a user in grace alike: not a member, not an admin, no name', async () => {
    const unknown = await apiMember(t.db, service, UNKNOWN_DISCORD_ID);
    expect(unknown).toEqual({
      discordId: UNKNOWN_DISCORD_ID,
      member: false,
      isAdmin: false,
      name: null,
    });
    const grace = await apiMember(t.db, service, LEAVER_DISCORD_ID);
    expect(grace).toEqual({ ...unknown, discordId: LEAVER_DISCORD_ID });
  });

  it('follows the user’s status on the next request', async () => {
    const user = await seedUser(t.db, { name: 'Flip Flop' });
    const discordId = '100000000000000004';
    await setDiscordId(user, discordId);
    expect(await apiMember(t.db, service, discordId)).toMatchObject({ member: true });
    await t.db.update(users).set({ status: 'grace' }).where(eq(users.id, user.id));
    expect(await apiMember(t.db, service, discordId)).toEqual({
      discordId,
      member: false,
      isAdmin: false,
      name: null,
    });
    await t.db.update(users).set({ status: 'active' }).where(eq(users.id, user.id));
    expect(await apiMember(t.db, service, discordId)).toMatchObject({
      member: true,
      name: 'Flip Flop',
    });
  });

  it('needs no category: any service key may ask', async () => {
    const statsOnly = await serviceKey(['stats']);
    expect(await apiMember(t.db, statsOnly, MEMBER_DISCORD_ID)).toMatchObject({ member: true });
  });

  it.each([
    ['empty', ''],
    ['14 digits', '1'.repeat(14)],
    ['23 digits', '1'.repeat(23)],
    ['letters', 'abcdefghijklmnopqr'],
    ['a name', 'Molly Member'],
    ['a padded id', ` ${MEMBER_DISCORD_ID}`],
    ['a signed id', `-${MEMBER_DISCORD_ID}`],
    ['full-width digits', '１'.repeat(18)],
    ['a NUL byte (DB-1)', `${MEMBER_DISCORD_ID}\u0000`],
  ])('refuses %s as invalid, before any lookup', async (_label, value) => {
    expect(isDiscordIdLike(value)).toBe(false);
    const err = await apiMember(t.db, service, value).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('invalid');
    expect((err as ApiError).message).toContain('discord_id');
  });

  it('accepts ids of 15 to 22 digits', async () => {
    for (const length of [15, 18, 22]) {
      const discordId = '9'.repeat(length);
      expect(isDiscordIdLike(discordId)).toBe(true);
      expect(await apiMember(t.db, service, discordId)).toMatchObject({ discordId, member: false });
    }
  });
});

describe('apiMember with a user key', () => {
  it('answers null whoever the creator is and whatever the id: the endpoint is not theirs', async () => {
    const memberKey = await makeKey(t.db, member.id, {}, NOW);
    const adminKey = await makeKey(t.db, admin.id, {}, NOW);
    for (const principal of [memberKey.principal, adminKey.principal]) {
      expect(await apiMember(t.db, principal, MEMBER_DISCORD_ID)).toBeNull();
      expect(await apiMember(t.db, principal, UNKNOWN_DISCORD_ID)).toBeNull();
      // Not a 400 either: nothing about the endpoint shows, not even its parameter rules.
      expect(await apiMember(t.db, principal, 'not-an-id')).toBeNull();
    }
  });
});

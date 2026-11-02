/**
 * GET /accounts/{id}/collection-log and GET /collection-log (D-131): the collection log pages (D-118)
 * through a key. The page's 404 rule (`events` or `hiscores`), the key's categories and account scope
 * on top of the creator's access, a service key's guild audience, fetched_at cut without `activity`
 * (D-50), the filters and limits, and `accounts` on the guild form.
 */
import { accountHiscores } from '@hub/db';
import { createTestDatabase, type TestDatabase } from '@hub/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  seedAccount,
  seedEvent,
  seedSharing,
  seedUser,
  type SeededAccount,
  type SeededUser,
} from '../accounts/test-support';
import { authenticateApiKey, type ApiPrincipal } from './key-auth';
import {
  COLLECTION_LOG_MAX_LIMIT,
  apiAccountCollectionLog,
  apiGuildCollectionLog,
} from './collection-log';
import { ApiError } from './errors';
import { createServiceKey } from './service-keys';
import { makeKey, present, type TestKey } from './test-support';

const NOW = new Date('2026-10-24T12:00:00Z');
const at = (iso: string) => new Date(iso);

let t: TestDatabase;
let owner: SeededUser;
let member: SeededUser;
let mira: SeededAccount;
let rival: SeededAccount;
/** Events private: only its owner's keys read its slots. */
let quiet: SeededAccount;
let memberKey: TestKey;
let ownerKey: TestKey;
let service: ApiPrincipal;

function clog(account: SeededAccount, iso: string, item: string, itemId = 1, killCount?: number) {
  return seedEvent(t.db, account.id, {
    type: 'collection_log',
    occurredAt: at(iso),
    itemId,
    valueGp: 1000,
    data: {
      type: 'collectionLog',
      data: { itemName: item, itemId, value: 1000, killCount },
      eventId: `${account.id}-${iso}`,
      timestamp: 0,
    },
  });
}

function loot(account: SeededAccount, iso: string, source: string) {
  return seedEvent(t.db, account.id, {
    type: 'loot',
    occurredAt: at(iso),
    valueGp: 5000,
    data: { type: 'loot', data: { source: { text: source } }, eventId: `l-${iso}`, timestamp: 0 },
  });
}

async function hiscores(account: SeededAccount, score: number) {
  await t.db.insert(accountHiscores).values({
    accountId: account.id,
    lookupName: account.name,
    mode: 'regular',
    status: 'ok',
    lastAttemptAt: at('2026-10-24T10:17:00Z'),
    fetchedAt: at('2026-10-24T10:17:00Z'),
    main: {
      skills: [{ name: 'Overall', rank: 10, level: 1500, xp: 50_000_000 }],
      activities: [{ name: 'Collections Logged', rank: 4321, score }],
    },
  });
}

beforeAll(async () => {
  t = await createTestDatabase('api-collection-log');
  owner = await seedUser(t.db, { name: 'Owner' });
  member = await seedUser(t.db, { name: 'Member' });
  const admin = await seedUser(t.db, { name: 'Admin', isAdmin: true });
  mira = await seedAccount(t.db, { owner: owner.id, name: 'Clog Mira' });
  rival = await seedAccount(t.db, { owner: member.id, name: 'Rival' });
  quiet = await seedAccount(t.db, { owner: owner.id, name: 'Quiet' });
  await seedSharing(t.db, quiet.id, 'events', 'private');

  await loot(mira, '2026-10-20T18:00:00Z', 'Zulrah');
  await clog(mira, '2026-10-20T18:00:02Z', 'Tanzanite fang', 12922, 212);
  await loot(mira, '2026-10-21T18:00:00Z', 'Zulrah');
  await clog(mira, '2026-10-21T18:00:03Z', 'Magic fang', 12932, 260);
  await clog(mira, '2026-10-22T09:00:00Z', 'Pet snakeling', 12921);
  await loot(rival, '2026-10-19T20:00:00Z', 'Zulrah');
  await clog(rival, '2026-10-19T20:00:01Z', 'Tanzanite fang', 12922, 90);
  await clog(quiet, '2026-10-18T20:00:00Z', 'Tanzanite fang', 12922, 40);
  await hiscores(mira, 512);
  await hiscores(rival, 800);

  memberKey = await makeKey(t.db, member.id, { name: 'member' }, NOW);
  ownerKey = await makeKey(t.db, owner.id, { name: 'owner' }, NOW);
  const created = await createServiceKey(t.db, {
    actor: admin.viewer,
    input: { name: 'bot', categories: ['events', 'hiscores'] },
    now: NOW,
  });
  const auth = await authenticateApiKey(t.db, `Bearer ${created.key}`, NOW);
  if (!auth.ok) throw new Error(auth.reason);
  service = auth.principal;
});

afterAll(async () => {
  await t?.drop();
});

describe('apiAccountCollectionLog', () => {
  it('gives the total and the slots newest first, with counts by source', async () => {
    const log = present(
      await apiAccountCollectionLog(t.db, memberKey.principal, mira.publicId, {}, NOW),
    );
    expect(log.account).toEqual({ id: mira.publicId, name: 'Clog Mira' });
    expect(log.total).toEqual({
      logged: 512,
      rank: 4321,
      modeRank: null,
      mode: 'regular',
      fetchedAt: '2026-10-24T10:17:00.000Z',
      gained30: 0,
    });
    expect(log.slots!.map((s) => [s.item, s.source, s.killCount])).toEqual([
      ['Pet snakeling', null, null],
      ['Magic fang', 'Zulrah', 260],
      ['Tanzanite fang', 'Zulrah', 212],
    ]);
    expect(log.groups).toEqual([
      { source: 'Zulrah', count: 2 },
      { source: null, count: 1 },
    ]);
    expect(log.truncated).toBe(false);
  });

  it('filters by source and time, and says when the limit cut the slots', async () => {
    const zulrah = present(
      await apiAccountCollectionLog(
        t.db,
        memberKey.principal,
        mira.publicId,
        { source: ' zulrah ' },
        NOW,
      ),
    );
    expect(zulrah.slots!.map((s) => s.item)).toEqual(['Magic fang', 'Tanzanite fang']);
    expect(zulrah.groups).toEqual([{ source: 'Zulrah', count: 2 }]);

    const since = present(
      await apiAccountCollectionLog(
        t.db,
        memberKey.principal,
        mira.publicId,
        { since: at('2026-10-21T00:00:00Z'), limit: 1 },
        NOW,
      ),
    );
    expect(since.slots!.map((s) => s.item)).toEqual(['Pet snakeling']);
    expect(since.groups!.reduce((n, g) => n + g.count, 0)).toBe(2);
    expect(since.truncated).toBe(true);
  });

  it('cuts fetched_at to the UTC day for a key without `activity` (D-50)', async () => {
    const key = await makeKey(t.db, member.id, { categories: ['hiscores'] }, NOW);
    const log = present(await apiAccountCollectionLog(t.db, key.principal, mira.publicId, {}, NOW));
    expect(log.total!.fetchedAt).toBe('2026-10-24T00:00:00.000Z');
    expect(log.slots).toBeNull();
    expect(log.groups).toBeNull();
  });

  it('is null (the one 404) without `events` and `hiscores`, out of scope, or not shared', async () => {
    const statsOnly = await makeKey(t.db, member.id, { categories: ['stats'] }, NOW);
    const scoped = await makeKey(
      t.db,
      member.id,
      { accountScope: 'list', accountPublicIds: [rival.publicId] },
      NOW,
    );
    expect(
      await apiAccountCollectionLog(t.db, statsOnly.principal, mira.publicId, {}, NOW),
    ).toBeNull();
    expect(
      await apiAccountCollectionLog(t.db, scoped.principal, mira.publicId, {}, NOW),
    ).toBeNull();
    expect(
      await apiAccountCollectionLog(t.db, memberKey.principal, 'Zz9Zz9Zz9Zz9', {}, NOW),
    ).toBeNull();
    expect(await apiAccountCollectionLog(t.db, memberKey.principal, 'bad id!', {}, NOW)).toBeNull();
    // Quiet shares its hiscores but not its events: the member gets the total only, its owner both.
    const asMember = present(
      await apiAccountCollectionLog(t.db, memberKey.principal, quiet.publicId, {}, NOW),
    );
    expect(asMember.slots).toBeNull();
    const asOwner = present(
      await apiAccountCollectionLog(t.db, ownerKey.principal, quiet.publicId, {}, NOW),
    );
    expect(asOwner.slots!.map((s) => s.item)).toEqual(['Tanzanite fang']);
  });

  it('refuses a bad limit, source or since', async () => {
    for (const params of [
      { limit: 0 },
      { limit: COLLECTION_LOG_MAX_LIMIT + 1 },
      { source: '  ' },
      { source: 'x'.repeat(65) },
      { since: new Date('nope') },
    ]) {
      await expect(
        apiAccountCollectionLog(t.db, memberKey.principal, mira.publicId, params, NOW),
      ).rejects.toBeInstanceOf(ApiError);
    }
  });
});

describe('apiGuildCollectionLog', () => {
  it('gives the board, the newest slots and how many accounts were searched', async () => {
    const guild = await apiGuildCollectionLog(t.db, memberKey.principal, {}, NOW);
    expect(guild.board.map((r) => [r.account.name, r.logged, r.seen])).toEqual([
      ['Rival', 800, 1],
      ['Clog Mira', 512, 3],
    ]);
    expect(guild.board[1]!.latest).toEqual({
      item: 'Pet snakeling',
      itemId: 12921,
      at: '2026-10-22T09:00:00.000Z',
    });
    expect(guild.recent.map((s) => [s.account.name, s.item])).toEqual([
      ['Clog Mira', 'Pet snakeling'],
      ['Clog Mira', 'Magic fang'],
      ['Clog Mira', 'Tanzanite fang'],
      ['Rival', 'Tanzanite fang'],
    ]);
    expect(guild.searchable).toBe(2);
    expect(guild.items).toBeNull();
    expect(guild.truncated).toBe(false);
  });

  it('answers who has an item, first logged first, over what the key reads', async () => {
    const asMember = await apiGuildCollectionLog(t.db, memberKey.principal, { item: 'FANG' }, NOW);
    expect(asMember.items!.map((i) => [i.item, i.holders.map((h) => h.account.name)])).toEqual([
      ['Tanzanite fang', ['Rival', 'Clog Mira']],
      ['Magic fang', ['Clog Mira']],
    ]);
    expect(asMember.items![0]!.holders[0]).toEqual({
      account: { id: rival.publicId, name: 'Rival' },
      at: '2026-10-19T20:00:01.000Z',
      killCount: 90,
    });
    // The owner also reads Quiet's private events; the guild audience doesn't.
    const asOwner = await apiGuildCollectionLog(
      t.db,
      ownerKey.principal,
      { item: 'tanzanite' },
      NOW,
    );
    expect(asOwner.items![0]!.holders.map((h) => h.account.name)).toEqual([
      'Quiet',
      'Rival',
      'Clog Mira',
    ]);
    const asService = await apiGuildCollectionLog(t.db, service, { item: 'tanzanite' }, NOW);
    expect(asService.items![0]!.holders.map((h) => h.account.name)).toEqual(['Rival', 'Clog Mira']);
    expect(asService.searchable).toBe(2);
  });

  it('narrows to `accounts`, each of which must be readable', async () => {
    const one = await apiGuildCollectionLog(
      t.db,
      memberKey.principal,
      { accounts: [rival.publicId], item: 'fang' },
      NOW,
    );
    expect(one.board.map((r) => r.account.name)).toEqual(['Rival']);
    expect(one.items!.map((i) => i.holders.length)).toEqual([1]);
    expect(one.searchable).toBe(1);

    const hidden = await seedAccount(t.db, {
      owner: member.id,
      name: 'Hidden',
      hiddenFromGuild: true,
    });
    for (const id of ['Zz9Zz9Zz9Zz9', hidden.publicId]) {
      const err = await apiGuildCollectionLog(
        t.db,
        memberKey.principal,
        { accounts: [id] },
        NOW,
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).code).toBe('not_found');
    }
    await expect(
      apiGuildCollectionLog(
        t.db,
        memberKey.principal,
        { accounts: Array.from({ length: 11 }, (_, i) => `id${i}`) },
        NOW,
      ),
    ).rejects.toMatchObject({ code: 'invalid' });
  });

  it('cuts the board at `limit`, and refuses a lookup too short or too long', async () => {
    const top = await apiGuildCollectionLog(t.db, memberKey.principal, { limit: 1 }, NOW);
    expect(top.board.map((r) => r.account.name)).toEqual(['Rival']);
    expect(top.truncated).toBe(true);
    for (const item of ['a', ' x ', 'y'.repeat(65)]) {
      await expect(
        apiGuildCollectionLog(t.db, memberKey.principal, { item }, NOW),
      ).rejects.toMatchObject({ code: 'invalid' });
    }
  });

  it('is empty for a key that reads neither category', async () => {
    const statsOnly = await makeKey(t.db, member.id, { categories: ['stats'] }, NOW);
    const guild = await apiGuildCollectionLog(t.db, statsOnly.principal, { item: 'fang' }, NOW);
    expect(guild).toEqual({ board: [], recent: [], items: [], searchable: 0, truncated: false });
  });
});

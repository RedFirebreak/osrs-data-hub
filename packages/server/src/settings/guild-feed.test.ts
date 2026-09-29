import { DEFAULT_GUILD_FEED_FILTER } from '@hub/core';
import { auditLog, hubSettings } from '@hub/db';
import { createTestDatabase, type TestDatabase } from '@hub/db/testing';
import { eq } from 'drizzle-orm';
import { ZodError } from 'zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getGuildOverview } from '../accounts/guild';
import { listFeed } from '../accounts/list-feed';
import {
  seedAccount,
  seedEvent,
  seedUser,
  type SeededAccount,
  type SeededUser,
} from '../accounts/test-support';
import { getGuildFeedFilter, setGuildFeedFilter } from './guild-feed';

let t: TestDatabase;
let owner: SeededUser;
let member: SeededUser;
let alpha: SeededAccount;
/** Event seqs by name. */
const seq: Record<string, number> = {};

beforeAll(async () => {
  t = await createTestDatabase('guild-feed');
  owner = await seedUser(t.db);
  member = await seedUser(t.db);
  alpha = await seedAccount(t.db, { name: 'Alpha', owner: owner.id });
  const add = async (name: string, values: Parameters<typeof seedEvent>[2]) => {
    seq[name] = (await seedEvent(t.db, alpha.id, values)).seq;
  };
  await add('cheapLoot', { type: 'loot', valueGp: 1 });
  await add('noValueLoot', { type: 'loot', valueGp: null });
  await add('richLoot', { type: 'loot', valueGp: 50_000 });
  await add('cheapPk', { type: 'pk_loot', valueGp: 500 });
  await add('cheapClog', { type: 'collection_log', valueGp: 1 });
  await add('level99', { type: 'level_up', skill: 'Attack', level: 99 });
  await add('level100', { type: 'level_up', skill: 'Attack', level: 100 });
  await add('combat126', { type: 'level_up', skill: 'Combat', level: 126 });
  await add('death', { type: 'death', valueGp: 1 });
});

afterAll(async () => {
  await t.drop();
});

beforeEach(async () => {
  await t.db.delete(hubSettings).where(eq(hubSettings.key, 'guild_feed'));
});

function names(feed: readonly { seq: number }[]): string[] {
  const bySeq = new Map(Object.entries(seq).map(([name, s]) => [s, name]));
  return feed.map((e) => bySeq.get(e.seq) ?? String(e.seq)).sort();
}

describe('getGuildFeedFilter', () => {
  it('returns the defaults without a stored value', async () => {
    expect(await getGuildFeedFilter(t.db)).toEqual(DEFAULT_GUILD_FEED_FILTER);
  });

  it('reads a stored value leniently: unknown keys ignored, missing and invalid ones defaulted', async () => {
    await t.db
      .insert(hubSettings)
      .values({ key: 'guild_feed', value: { minLootValue: 5_000, later: true } });
    expect(await getGuildFeedFilter(t.db)).toEqual({
      minLootValue: 5_000,
      showVirtualLevels: false,
    });
    await t.db
      .update(hubSettings)
      .set({ value: { minLootValue: -1, showVirtualLevels: true } })
      .where(eq(hubSettings.key, 'guild_feed'));
    expect(await getGuildFeedFilter(t.db)).toEqual(DEFAULT_GUILD_FEED_FILTER);
  });
});

describe('setGuildFeedFilter', () => {
  it('stores the filter and audits the change', async () => {
    const filter = { minLootValue: 100_000, showVirtualLevels: true };
    expect(await setGuildFeedFilter(t.db, { filter, actorUserId: owner.id })).toEqual(filter);
    expect(await getGuildFeedFilter(t.db)).toEqual(filter);
    const [entry] = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'hub.guild_feed_changed'));
    expect(entry).toMatchObject({
      actorUserId: owner.id,
      targetType: 'hub',
      targetId: 'guild_feed',
      meta: filter,
    });
  });

  it('refuses a negative, fractional or too large minimum', async () => {
    for (const minLootValue of [-1, 1.5, 2 ** 31 + 1]) {
      await expect(
        setGuildFeedFilter(t.db, {
          filter: { minLootValue, showVirtualLevels: false },
          actorUserId: owner.id,
        }),
      ).rejects.toThrow(ZodError);
    }
    expect(await getGuildFeedFilter(t.db)).toEqual(DEFAULT_GUILD_FEED_FILTER);
  });
});

describe('the guild feed under the filter (D-81)', () => {
  it('hides only virtual levels by default, never combat level', async () => {
    const feed = await listFeed(t.db, member.viewer, { guildFilter: DEFAULT_GUILD_FEED_FILTER });
    expect(names(feed)).toEqual(
      Object.keys(seq)
        .filter((n) => n !== 'level100')
        .sort(),
    );
  });

  it('leaves out loot and PK loot below the minimum, a missing value counting as 0', async () => {
    const feed = await listFeed(t.db, member.viewer, {
      guildFilter: { minLootValue: 10_000, showVirtualLevels: true },
    });
    expect(names(feed)).toEqual(
      ['richLoot', 'cheapClog', 'level99', 'level100', 'combat126', 'death'].sort(),
    );
  });

  it('keeps the type filter and paging working together with it', async () => {
    const guildFilter = { minLootValue: 10_000, showVirtualLevels: false };
    const loot = await listFeed(t.db, member.viewer, { guildFilter, types: ['loot', 'pk_loot'] });
    expect(names(loot)).toEqual(['richLoot']);
    const older = await listFeed(t.db, member.viewer, {
      guildFilter,
      beforeSeq: seq.combat126,
    });
    expect(names(older)).toEqual(['cheapClog', 'level99', 'richLoot'].sort());
  });

  it('is not applied without a guildFilter (account timelines)', async () => {
    const feed = await listFeed(t.db, member.viewer, { accountPublicId: alpha.publicId });
    expect(names(feed)).toEqual(Object.keys(seq).sort());
  });

  it('is what the guild overview reads its feed with', async () => {
    await setGuildFeedFilter(t.db, {
      filter: { minLootValue: 10_000, showVirtualLevels: false },
      actorUserId: owner.id,
    });
    const overview = await getGuildOverview(t.db, member.viewer, { now: new Date() });
    expect(overview.feedFilter).toEqual({ minLootValue: 10_000, showVirtualLevels: false });
    expect(names(overview.feed)).toEqual(
      ['richLoot', 'cheapClog', 'level99', 'combat126', 'death'].sort(),
    );
  });
});

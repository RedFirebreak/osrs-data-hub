/**
 * The MCP tools (D-130, D-132): each one over data sent the way the plugin sends it, through a real
 * key's principal, asserting the trimmed shape a model gets: a summary, names before ids, formatted
 * GP, no plugin `data`, and "this key can't read" instead of a bare 404. Plus the pure parts: dates,
 * the stays of a trail, and how an account name is resolved (D-134).
 */
import { authenticateApiKey, type ApiPrincipal } from '@hub/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ATTACK_GAIN,
  fixture,
  ingest,
  makeKey,
  seedWorld,
  type World,
} from '@/app/api/v1/test-support';
import { withTestDb, type WebTestContext } from '@/lib/test-utils';
import { ToolError, resolveAccount } from './resolve';
import { TOOLS, parseWhen, regionId, stays, type ToolContext, type ToolResult } from './tools';

vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  connection: () => Promise.resolve(),
}));

let ctx: WebTestContext;
let world: World;
let member: ApiPrincipal;
let statsOnly: ApiPrincipal;

async function principalOf(key: string): Promise<ApiPrincipal> {
  const auth = await authenticateApiKey(ctx.t.db, `Bearer ${key}`);
  if (!auth.ok) throw new Error(`key refused: ${auth.reason}`);
  return auth.principal;
}

beforeAll(async () => {
  ctx = await withTestDb({ label: 'mcptools' });
  world = await seedWorld(ctx);
  // Kree'arra's drop and the collection log slot it filled, in one payload.
  const body = fixture('snapshot-normal', { hash: world.main.hash, name: world.main.name });
  body.events = [
    ...(fixture('event-loot').events ?? []),
    ...(fixture('event-collectionlog').events ?? []),
  ];
  await ingest(world.device.token, body, new Date(Date.now() - 10_000));
  member = await principalOf((await makeKey(ctx, world.memberId)).key);
  statsOnly = await principalOf(
    (await makeKey(ctx, world.memberId, { categories: ['stats'] })).key,
  );
});
afterAll(async () => {
  await ctx.cleanup();
});

function call(
  name: string,
  args: Record<string, unknown>,
  principal = member,
): Promise<ToolResult> {
  const def = TOOLS.find((t) => t.name === name);
  if (!def) throw new Error(`no tool ${name}`);
  const c: ToolContext = { db: ctx.t.db, principal, now: new Date() };
  return def.run(c, args as never);
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  const err = await promise.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(Error);
  return (err as Error).message;
}

describe('the tool list', () => {
  it('has the eleven tools of M7, each with a description naming its REST twin', () => {
    expect(TOOLS.map((t) => t.name)).toEqual([
      'list_accounts',
      'get_account',
      'get_gains',
      'recent_events',
      'search_events',
      'leaderboard',
      'get_hiscores',
      'collection_log',
      'who_has',
      'sessions',
      'locations',
    ]);
    for (const t of TOOLS) expect(t.description, t.name).toMatch(/REST: GET \/api\/v1\//);
  });
});

describe('list_accounts', () => {
  it('lists names first, who is online, and what the key reads on each', async () => {
    const r = await call('list_accounts', {});
    expect(r.summary).toBe('2 accounts, 1 online (world 302)');
    expect(r.accounts).toEqual([
      expect.objectContaining({
        name: world.main.name,
        id: world.main.id,
        type: 'Normal',
        owner: 'Owner',
        online: true,
        world: 302,
        categories: expect.arrayContaining(['stats', 'events', 'location_history']) as unknown,
      }),
      expect.objectContaining({ name: world.alt.name, online: false }),
    ]);
    expect(typeof r.generated_at).toBe('string');
  });
});

describe('get_account', () => {
  it('gives levels by default, XP only with detail', async () => {
    const r = await call('get_account', { account: 'alpha main' });
    expect(r.summary).toMatch(/^Alpha Main: total level \d+, online on world 302$/);
    const stats = r.stats as { levels: Record<string, number>; total_level: number };
    expect(stats.levels.Attack).toBeTypeOf('number');
    expect(stats).not.toHaveProperty('skills');
    expect(r.presence).toMatchObject({ online: true, world: 302 });
    const detailed = await call('get_account', { account: world.main.id, detail: true });
    expect((detailed.stats as { skills: unknown[] }).skills[0]).toMatchObject({
      skill: 'Attack',
      xp: expect.any(Number) as unknown,
    });
  });

  it('gives gear, a merged inventory and wealth when asked, with values formatted', async () => {
    const r = await call('get_account', {
      account: 'Alpha',
      sections: ['equipment', 'inventory', 'wealth'],
    });
    expect(r).not.toHaveProperty('stats');
    const gear = r.equipment as { items: { slot?: string; name: string }[]; value: string };
    expect(gear.items.length).toBeGreaterThan(0);
    expect(gear.items[0]!.slot).toBeTypeOf('string');
    expect(gear.value).toMatch(/^[\d.]+[KMB]?$/);
    expect((r.inventory as { items: unknown[] }).items.length).toBeGreaterThan(0);
    expect(r.wealth).toMatchObject({ total: expect.any(String) as unknown });
  });

  it("says what the key can't read, and what the player doesn't send", async () => {
    const r = await call(
      'get_account',
      { account: 'Alpha Main', sections: ['stats', 'equipment', 'presence'] },
      statsOnly,
    );
    expect(r.stats).toBeTypeOf('object');
    expect(r.equipment).toBe('not readable with this key (needs "equipment", shared by the owner)');
    expect(r.presence).toBe('not readable with this key (needs "activity", shared by the owner)');
    const alt = await call('get_account', { account: 'Bravo Alt', sections: ['equipment'] });
    expect(alt.equipment).toBe("the player doesn't send this from the plugin");
  });
});

describe('get_gains', () => {
  it('lists only skills with a gain, most first, with the total', async () => {
    const r = await call('get_gains', { account: 'Alpha Main', period: 'week' });
    expect(r.summary).toBe(`Alpha Main gained 5K XP (week): Attack 5K`);
    expect(r).toMatchObject({
      period: 'week',
      total_xp: ATTACK_GAIN,
      skills: [{ skill: 'Attack', xp: ATTACK_GAIN, gained: '5K' }],
    });
  });

  it("refuses an account whose stats the key can't read, saying which category", async () => {
    const eventsOnly = await principalOf(
      (await makeKey(ctx, world.memberId, { categories: ['events'] })).key,
    );
    expect(await refusal(call('get_gains', { account: 'Alpha Main' }, eventsOnly))).toMatch(
      /can't read Alpha Main's XP: it needs the "stats" category/,
    );
  });
});

describe('recent_events and search_events', () => {
  it('give the line and a few typed fields, never the plugin data', async () => {
    const r = await call('recent_events', { types: ['loot'] });
    const events = r.events as Record<string, unknown>[];
    expect(events.length).toBe(2);
    expect(events[0]).toEqual({
      id: expect.any(String) as unknown,
      type: 'loot',
      account: 'Alpha Main',
      occurred_at: expect.any(String) as unknown,
      value_gp: 35_237_280,
      value: '35.2M',
      line: expect.stringContaining('Armadyl chestplate') as unknown,
    });
    expect(r.next_cursor).toBeNull();
    expect(r.summary).toMatch(/^2 events, newest first; latest: /);
  });

  it('finds drops by NPC and by any item, and asks for one of the two', async () => {
    const byNpc = await call('search_events', { npc: 'kree', accounts: ['alpha main'] });
    expect((byNpc.events as unknown[]).length).toBe(2);
    const byItem = await call('search_events', { item: 'big bones', limit: 1 });
    expect((byItem.events as unknown[]).length).toBe(1);
    expect(byItem.next_cursor).toBeTypeOf('string');
    expect(await refusal(call('search_events', {}))).toMatch(/Give item or npc/);
  });
});

describe('leaderboard', () => {
  it('ranks gains by name with formatted XP', async () => {
    const r = await call('leaderboard', { kind: 'gains', skill: 'attack', period: 'week' });
    expect(r.summary).toBe('Attack (week): Alpha Main leads with 5K XP');
    expect(r.boards).toEqual([
      {
        skill: 'Attack',
        entries: [{ rank: 1, account: 'Alpha Main', xp: ATTACK_GAIN, gained: '5K' }],
      },
    ]);
  });

  it('ranks drops with their line', async () => {
    const r = await call('leaderboard', { kind: 'loot', period: 'week', limit: 1 });
    expect(r.summary).toMatch(/^Biggest drop \(week\): .*Armadyl chestplate/);
    expect(r.entries).toEqual([expect.objectContaining({ rank: 1, value: '35.2M' })]);
  });
});

describe('get_hiscores', () => {
  it('says when the hiscores were never read', async () => {
    const r = await call('get_hiscores', { accounts: ['Alpha Main'], fields: ['bosses'] });
    expect(r.summary).toBe("Alpha Main's hiscores haven't been read yet");
    expect(r.accounts).toEqual([
      { account: 'Alpha Main', status: 'pending', mode: 'regular', read_at: null, bosses: [] },
    ]);
  });
});

describe('collection_log and who_has', () => {
  it('lists slots as lines with the source and kill count', async () => {
    const r = await call('collection_log', { account: 'Alpha Main' });
    expect(r.slots).toEqual([
      expect.stringMatching(/^Tanzanite fang \(kc 212\) from Kree'arra on \d{4}-\d{2}-\d{2}$/),
    ]);
    expect(r.by_source).toEqual([{ source: "Kree'arra", count: 1 }]);
    expect(r.summary).toMatch(/the hub saw 1 slot logged; latest: Tanzanite fang/);
  });

  it('names the holders and how many accounts were searched', async () => {
    const r = await call('who_has', { item: 'FANG' });
    expect(r).toMatchObject({
      summary: '1 account of 2 accounts that share their log logged Tanzanite fang: Alpha Main',
      searchable: 2,
      items: [
        {
          item: 'Tanzanite fang',
          holder_count: 1,
          holders: [{ account: 'Alpha Main', kill_count: 212 }],
        },
      ],
    });
    const none = await call('who_has', { item: 'twisted bow' });
    expect(none.summary).toBe(
      'Nobody of 2 accounts that share their log has logged an item matching "twisted bow"',
    );
  });
});

describe('sessions and locations', () => {
  it('lists sessions newest first, an open one as ongoing', async () => {
    const r = await call('sessions', { account: 'Alpha Main' });
    const list = r.sessions as { end: string; minutes: number }[];
    expect(list.length).toBeGreaterThan(0);
    expect(list[0]!.end).toBe('ongoing');
    expect(r.summary).toMatch(/^Alpha Main: \d+ sessions?, /);
  });

  it('summarises the trail by region, or gives the points', async () => {
    const r = await call('locations', { account: 'Alpha Main' });
    const stayList = r.stays as { region: number }[];
    expect(stayList.length).toBeGreaterThan(0);
    const at = fixture('snapshot-normal').player?.location as { x: number; y: number };
    expect(stayList[0]!.region).toBe(regionId(at.x, at.y));
    const raw = await call('locations', { account: 'Alpha Main', summarise: false });
    expect((raw.points as unknown[]).length).toBeGreaterThan(0);
    expect(await refusal(call('locations', { account: 'Alpha Main' }, statsOnly))).toMatch(
      /needs the "location_history" category/,
    );
  });
});

describe('resolveAccount (D-134)', () => {
  it('takes an id, an exact name in any case, or a unique part of one', async () => {
    expect(await resolveAccount(ctx.t.db, member, world.main.id)).toEqual({
      id: world.main.id,
      name: 'Alpha Main',
    });
    expect((await resolveAccount(ctx.t.db, member, 'BRAVO ALT')).name).toBe('Bravo Alt');
    expect((await resolveAccount(ctx.t.db, member, 'bravo')).name).toBe('Bravo Alt');
  });

  it('asks which one when several match, and says where the list is when none does', async () => {
    const several = await refusal(resolveAccount(ctx.t.db, member, 'a'));
    expect(several).toMatch(/matches several accounts: Alpha Main, Bravo Alt/);
    const none = await refusal(resolveAccount(ctx.t.db, member, 'Zezima'));
    expect(none).toMatch(/No account named "Zezima".*list_accounts/);
    await expect(resolveAccount(ctx.t.db, member, ' ')).rejects.toBeInstanceOf(ToolError);
  });
});

describe('parseWhen', () => {
  const now = new Date('2026-11-02T12:00:00Z');
  it('reads a bare date as the whole UTC day, ending at most now', () => {
    expect(parseWhen('2026-11-01', 'from', now).toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(parseWhen('2026-11-01', 'to', now).toISOString()).toBe('2026-11-02T00:00:00.000Z');
    expect(parseWhen('2026-11-02', 'to', now)).toEqual(now);
    expect(parseWhen('2026-11-01T18:00:00Z', 'to', now).toISOString()).toBe(
      '2026-11-01T18:00:00.000Z',
    );
  });

  it("refuses what isn't a date", () => {
    expect(() => parseWhen('yesterday', 'from', now)).toThrow(ToolError);
  });
});

describe('stays', () => {
  const at = (minute: number) => new Date(Date.UTC(2026, 10, 1, 12, minute)).toISOString();
  it('groups a trail by region and ends a stay at a gap', () => {
    const result = stays([
      { at: at(0), x: 3200, y: 3200, plane: 0, via: null },
      { at: at(5), x: 3210, y: 3210, plane: 0, via: 'move' },
      { at: at(10), x: 2440, y: 3090, plane: 0, via: 'teleport' },
      { at: at(20), x: 2441, y: 3091, plane: 0, via: 'move' },
      { at: at(60), x: 2442, y: 3092, plane: 0, via: 'gap' },
    ]);
    expect(result.map((s) => [s.region, s.ms / 60_000, s.arrived_by])).toEqual([
      [regionId(3200, 3200), 10, null],
      [regionId(2440, 3090), 10, 'teleport'],
      [regionId(2442, 3092), 0, 'gap'],
    ]);
  });
});

/**
 * POST /api/v1/mcp (D-128..D-135) spoken over HTTP the way an MCP client speaks it, with a real key:
 * initialize, tools/list, a tool call (who_has), the resources and prompts, a tool error a model can
 * read, and the key wrapper's 401 and 429. GET and DELETE answer 405; the preflight allows POST.
 */
import { API_RATE_LIMIT, createServiceKey } from '@hub/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getApiLimits, setApiLimitsForTests } from '@/lib/api-v1/with-api-key';
import { withTestDb, type WebTestContext } from '@/lib/test-utils';
import * as mcpRoute from './mcp/route';
import {
  expectCors,
  fixture,
  freshLimits,
  ingest,
  makeKey,
  seedWorld,
  type TestKey,
  type World,
} from './test-support';

vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  connection: () => Promise.resolve(),
}));

const PROTOCOL = '2025-06-18';

let ctx: WebTestContext;
let world: World;
let key: TestKey;
let serviceKey: string;

beforeAll(async () => {
  ctx = await withTestDb({ label: 'v1mcp', env: { DISCORD_GUILD_NAME: 'New Dutchies' } });
  world = await seedWorld(ctx);
  const body = fixture('snapshot-normal', { hash: world.main.hash, name: world.main.name });
  body.events = fixture('event-collectionlog').events ?? [];
  await ingest(world.device.token, body, new Date(Date.now() - 10_000));
  key = await makeKey(ctx, world.memberId, { name: 'Claude' });
  const adminId = await ctx.seedUser({ name: 'Admin', isAdmin: true });
  serviceKey = (
    await createServiceKey(ctx.t.db, {
      actor: { userId: adminId, status: 'active', isAdmin: true },
      input: { name: 'guild bot', categories: ['events'] },
    })
  ).key;
});
beforeEach(() => {
  freshLimits();
});
afterAll(async () => {
  setApiLimitsForTests();
  await ctx.cleanup();
});

let nextId = 1;

function post(message: unknown, opts: { key?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = {
    'x-forwarded-for': '192.0.2.10',
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': PROTOCOL,
    ...opts.headers,
  };
  if (opts.key !== undefined) headers.authorization = `Bearer ${opts.key}`;
  return mcpRoute.POST(
    ctx.request('/api/v1/mcp', { method: 'POST', headers, json: message, sameOrigin: false }),
  );
}

async function rpc(method: string, params: unknown = {}, k = key.key) {
  const res = await post({ jsonrpc: '2.0', id: nextId++, method, params }, { key: k });
  expect(res.status).toBe(200);
  expectCors(res);
  const body = (await res.json()) as { result?: Record<string, unknown>; error?: unknown };
  expect(body.error).toBeUndefined();
  return body.result!;
}

async function callTool(name: string, args: Record<string, unknown>, k = key.key) {
  const result = (await rpc('tools/call', { name, arguments: args }, k)) as {
    content: { type: string; text: string }[];
    isError?: boolean;
  };
  return { isError: result.isError === true, text: result.content[0]!.text };
}

describe('POST /api/v1/mcp', () => {
  it('initializes, as the hub, with tools, resources and prompts', async () => {
    const result = await rpc('initialize', {
      protocolVersion: PROTOCOL,
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    });
    expect(result).toMatchObject({
      protocolVersion: PROTOCOL,
      serverInfo: { name: 'osrs-data-hub', version: 'dev' },
      capabilities: {
        tools: expect.any(Object) as unknown,
        resources: expect.any(Object) as unknown,
        prompts: expect.any(Object) as unknown,
      },
    });
    expect(result.instructions).toMatch(/Old School RuneScape data of one guild/);
  });

  it('lists the eleven tools, read-only, with their input schemas', async () => {
    const { tools } = (await rpc('tools/list')) as {
      tools: { name: string; inputSchema: { properties?: object }; annotations: object }[];
    };
    expect(tools).toHaveLength(11);
    const whoHas = tools.find((t) => t.name === 'who_has')!;
    expect(Object.keys(whoHas.inputSchema.properties ?? {})).toEqual(['item', 'accounts']);
    for (const t of tools) expect(t.annotations).toMatchObject({ readOnlyHint: true });
  });

  it('answers who_has with the holders and how many accounts were searched', async () => {
    const { isError, text } = await callTool('who_has', { item: 'tanzanite' });
    expect(isError).toBe(false);
    const result = JSON.parse(text) as Record<string, unknown>;
    expect(result).toMatchObject({
      summary: '1 account of 2 accounts that share their log logged Tanzanite fang: Alpha Main',
      searchable: 2,
      items: [{ item: 'Tanzanite fang', holders: [{ account: 'Alpha Main', kill_count: 212 }] }],
    });
    expect(result.generated_at).toBeTypeOf('string');
  });

  it('gives a tool error the model can read, and refuses bad arguments', async () => {
    const unknown = await callTool('get_gains', { account: 'Zezima' });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toMatch(/No account named "Zezima"/);
    const short = await callTool('who_has', { item: 'x' });
    expect(short.isError).toBe(true);
    expect(short.text).toMatch(/item/);
  });

  it('reads hub://me and hub://accounts', async () => {
    const me = (await rpc('resources/read', { uri: 'hub://me' })) as {
      contents: { uri: string; text: string }[];
    };
    expect(JSON.parse(me.contents[0]!.text)).toMatchObject({
      guild: 'New Dutchies',
      hub_version: 'dev',
      features: expect.arrayContaining(['who_has', 'event_search']) as unknown,
      key: { kind: 'user', name: 'Claude', rate_limit_per_minute: API_RATE_LIMIT },
      user: 'Member',
      visible_accounts: 2,
    });
    const accounts = (await rpc('resources/read', { uri: 'hub://accounts' })) as {
      contents: { text: string }[];
    };
    expect(JSON.parse(accounts.contents[0]!.text)).toEqual([
      expect.objectContaining({ id: world.main.id, name: 'Alpha Main', owner: 'Owner' }),
      expect.objectContaining({ id: world.alt.id, name: 'Bravo Alt' }),
    ]);
  });

  it('offers the three prompts', async () => {
    const { prompts } = (await rpc('prompts/list')) as { prompts: { name: string }[] };
    expect(prompts.map((p) => p.name)).toEqual(['guild_today', 'player_day', 'who_has']);
    const got = (await rpc('prompts/get', { name: 'who_has', arguments: { item: 'Tumeken' } })) as {
      messages: { content: { text: string } }[];
    };
    expect(got.messages[0]!.content.text).toMatch(/who_has with item="Tumeken"/);
  });

  it('works with a service key, which sees the guild audience', async () => {
    const result = await rpc('resources/read', { uri: 'hub://me' }, serviceKey);
    const me = JSON.parse((result.contents as { text: string }[])[0]!.text) as Record<
      string,
      unknown
    >;
    expect(me).toMatchObject({ key: { kind: 'service', categories: ['events'] }, user: null });
  });

  it("is one request against the key's limit, and answers 401 and 429 like every v1 route", async () => {
    const res = await post(
      { jsonrpc: '2.0', id: nextId++, method: 'tools/list' },
      { key: key.key },
    );
    expect(res.headers.get('x-ratelimit-remaining')).toBe(String(API_RATE_LIMIT - 1));

    const unauthorized = await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get('www-authenticate')).toBe('Bearer');
    expectCors(unauthorized);

    for (let i = 0; i < API_RATE_LIMIT; i++) getApiLimits().perKey.hit(key.info.id);
    const limited = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { key: key.key });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toMatch(/^\d+$/);
  });

  it("refuses a body over 64 KiB, and a client that won't take JSON", async () => {
    const big = await post(
      { jsonrpc: '2.0', id: 3, method: 'tools/list', params: { pad: 'x'.repeat(70_000) } },
      { key: key.key },
    );
    expect(big.status).toBe(413);
    const sseOnly = await post(
      { jsonrpc: '2.0', id: 4, method: 'tools/list' },
      { key: key.key, headers: { accept: 'text/event-stream' } },
    );
    expect(sseOnly.status).toBe(406);
  });
});

describe('other methods', () => {
  it('answers GET and DELETE with 405, and a preflight that allows POST', async () => {
    for (const handler of [mcpRoute.GET, mcpRoute.DELETE]) {
      const res = handler();
      expect(res.status).toBe(405);
      expect(res.headers.get('allow')).toBe('POST, OPTIONS');
      expectCors(res);
    }
    const preflight = mcpRoute.OPTIONS();
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-methods')).toBe('POST, OPTIONS');
    expect(preflight.headers.get('access-control-allow-headers')).toMatch(/Mcp-Protocol-Version/);
  });
});

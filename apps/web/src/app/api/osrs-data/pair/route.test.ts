import { sha256Hex } from '@hub/core';
import { devices, pairingCodes } from '@hub/db';
import { PAIR_MESSAGES, createPairingCode, setDecommissioned } from '@hub/server';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PLUGIN_GET_ERROR } from '@/lib/deps';
import { withTestDb, type WebTestContext } from '@/lib/test-utils';
import { GET, HEAD, POST } from './route';

let ctx: WebTestContext;
let userId: string;

beforeAll(async () => {
  ctx = await withTestDb({ label: 'pair' });
  userId = await ctx.seedUser();
});
afterAll(() => ctx.cleanup());

/** POST /api/osrs-data/pair as the plugin sends it (OkHttp: no Origin, charset in the type). */
function pair(body: string, opts: { version?: string | null; ip?: string } = {}) {
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    'user-agent': 'okhttp/3.14.9',
    'x-forwarded-for': opts.ip ?? '203.0.113.10',
  };
  if (opts.version !== null) headers['x-osrs-exporter-version'] = opts.version ?? '1.5';
  return POST(
    ctx.request('/api/osrs-data/pair', { method: 'POST', body, headers, sameOrigin: false }),
  );
}

async function newCode(): Promise<string> {
  const created = await createPairingCode(ctx.t.db, { userId, ttlSeconds: 300 });
  return created.code;
}

describe('POST /api/osrs-data/pair', () => {
  it('exchanges a valid code for a token, shown once and never cached', async () => {
    const code = await newCode();
    const res = await pair(JSON.stringify({ code }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      ok: true,
      token: expect.stringMatching(/^[0-9a-f]{64}$/) as string,
      device_id: expect.any(String) as string,
      name: 'Test Hub',
    });
    const [device] = await ctx.t.db
      .select({ userId: devices.userId, tokenHash: devices.tokenHash, lastIp: devices.lastIp })
      .from(devices)
      .where(eq(devices.id, body.device_id as string));
    expect(device).toEqual({
      userId,
      tokenHash: sha256Hex(body.token as string),
      lastIp: '203.0.113.10',
    });

    // Single use.
    const again = await pair(JSON.stringify({ code }));
    expect(again.status).toBe(403);
    expect(await again.json()).toEqual({ ok: false, error: PAIR_MESSAGES.invalid });
  });

  it('refuses an outdated plugin with the exact dialog text and keeps the code', async () => {
    const code = await newCode();
    const res = await pair(JSON.stringify({ code }), { version: '1.4.2', ip: '203.0.113.11' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      ok: false,
      error:
        'HA Exporter 1.5 or newer is required. Restart RuneLite to update the plugin, then press Submit again.',
    });
    const missing = await pair(JSON.stringify({ code }), { version: null, ip: '203.0.113.11' });
    expect(missing.status).toBe(400);

    const [row] = await ctx.t.db
      .select({ consumedAt: pairingCodes.consumedAt })
      .from(pairingCodes)
      .where(eq(pairingCodes.code, code));
    expect(row?.consumedAt).toBeNull();
    // Still usable once the plugin is updated.
    expect((await pair(JSON.stringify({ code }), { ip: '203.0.113.11' })).status).toBe(200);
  });

  it('answers 400 for a malformed or oversized body', async () => {
    for (const body of ['', 'not json', '{"code":12345}', '{"code":"1234"}']) {
      const res = await pair(body, { ip: '203.0.113.12' });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ ok: false, error: PAIR_MESSAGES.malformed });
    }
    const big = await pair(JSON.stringify({ code: '12345', pad: 'x'.repeat(9000) }), {
      ip: '203.0.113.13',
    });
    expect(big.status).toBe(400);
  });

  it('rate-limits one client with an integer Retry-After (PLUGIN-5)', async () => {
    const ip = '198.51.100.77';
    for (let i = 0; i < 10; i++) expect((await pair('{}', { ip })).status).toBe(400);
    const res = await pair('{}', { ip });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toMatch(/^[1-9]\d*$/);
    expect(await res.json()).toEqual({ ok: false, error: PAIR_MESSAGES.rateLimited });
    // Another client is unaffected (the limiter is keyed by X-Forwarded-For, D-42).
    expect((await pair('{}', { ip: '198.51.100.78' })).status).toBe(400);
  });

  it('answers 410 while the hub is decommissioned (D-56)', async () => {
    await setDecommissioned(ctx.t.db, { value: true, actorUserId: userId });
    try {
      const res = await pair(JSON.stringify({ code: await newCode() }), { ip: '203.0.113.14' });
      expect(res.status).toBe(410);
      expect(await res.json()).toEqual({ ok: false, error: PAIR_MESSAGES.decommissioned });
    } finally {
      await setDecommissioned(ctx.t.db, { value: false, actorUserId: userId });
    }
  });
});

describe('GET/HEAD /api/osrs-data/pair', () => {
  it('answers 400 with the "enter the exact URL" text, never a redirect (D-38, PLUGIN-2)', async () => {
    const res = await GET(ctx.request('/api/osrs-data/pair', { sameOrigin: false }));
    expect(res.status).toBe(400);
    expect(res.headers.get('location')).toBeNull();
    expect(await res.json()).toEqual({
      ok: false,
      error:
        'This URL only accepts the HA Exporter plugin. In RuneLite, enter the hub URL exactly as shown in the pairing wizard, including https://.',
    });
    expect(PLUGIN_GET_ERROR.length).toBeLessThanOrEqual(200); // the plugin shows ≤ 200 characters

    const head = await HEAD(ctx.request('/api/osrs-data/pair', { method: 'HEAD' }));
    expect(head.status).toBe(400);
    expect(await head.text()).toBe('');
  });
});

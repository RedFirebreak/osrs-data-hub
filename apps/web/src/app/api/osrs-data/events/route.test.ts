import { readFileSync } from 'node:fs';
import path from 'node:path';
import { devices, events, osrsAccounts, rawPayloads } from '@hub/db';
import { eq } from 'drizzle-orm';
import { getLogger } from '@hub/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PLUGIN_GET_ERROR } from '@/lib/deps';
import { withTestDb, type WebTestContext } from '@/lib/test-utils';
import { GET, HEAD, POST } from './route';

// @hub/fixtures isn't a dependency of the web app; read its payload files directly.
const FIXTURE_DIR = path.resolve(
  import.meta.dirname,
  '../../../../../../../packages/fixtures/payloads',
);
const fixture = (name: string) => readFileSync(path.join(FIXTURE_DIR, `${name}.json`), 'utf8');

let ctx: WebTestContext;
let device: { id: string; token: string };

beforeAll(async () => {
  ctx = await withTestDb({ label: 'events' });
  device = await ctx.seedDevice(await ctx.seedUser());
});
afterAll(() => ctx.cleanup());

interface SendOptions {
  token?: string | null;
  version?: string | null;
  ip?: string;
  headers?: Record<string, string>;
}

/** POST /api/osrs-data/events as the plugin sends it (see packages/fixtures/http/events-request.http). */
function send(body: BodyInit, opts: SendOptions = {}) {
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    'user-agent': 'okhttp/3.14.9',
    'x-forwarded-for': opts.ip ?? '203.0.113.20',
    ...opts.headers,
  };
  const token = opts.token === undefined ? device.token : opts.token;
  if (token !== null) headers['x-osrs-token'] = token;
  if (opts.version !== null) headers['x-osrs-exporter-version'] = opts.version ?? '1.5';
  return POST(
    ctx.request('/api/osrs-data/events', { method: 'POST', body, headers, sameOrigin: false }),
  );
}

/** A body streamed in 16 KiB chunks without Content-Length (Transfer-Encoding: chunked). */
function chunkedBody(bytes: number): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= bytes) return controller.close();
      const size = Math.min(16 * 1024, bytes - sent);
      sent += size;
      controller.enqueue(new Uint8Array(size).fill(0x20));
    },
  });
}

describe('POST /api/osrs-data/events', () => {
  it('stores a snapshot fixture: 200 {"ok":true}', async () => {
    const res = await send(fixture('snapshot-normal'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const accounts = await ctx.t.db.select({ name: osrsAccounts.currentName }).from(osrsAccounts);
    expect(accounts.map((a) => a.name)).toContain('Zezima');
  });

  it('stores the events of an event fixture and absorbs a resend', async () => {
    const body = fixture('event-loot');
    expect((await send(body)).status).toBe(200);
    const stored = await ctx.t.db.select({ type: events.type }).from(events);
    expect(stored.map((e) => e.type)).toContain('loot');
    // The plugin resends byte-identical payloads after a timeout (PLUGIN-4): still 200, no duplicate.
    expect((await send(body)).status).toBe(200);
    expect(await ctx.t.db.select({ type: events.type }).from(events)).toHaveLength(stored.length);
  });

  it('records the client IP from X-Forwarded-For and the version on the archive', async () => {
    const res = await send(fixture('snapshot-world-hop'), {
      version: '1.5.1',
      headers: { 'x-forwarded-for': '198.51.100.1, 203.0.113.99' },
    });
    expect(res.status).toBe(200);
    const [row] = await ctx.t.db
      .select({ lastIp: devices.lastIp })
      .from(devices)
      .where(eq(devices.id, device.id));
    // TRUST_PROXY_HOPS=1: the entry our proxy appended, not the client-supplied one (D-42).
    expect(row?.lastIp).toBe('203.0.113.99');
    const archived = await ctx.t.db
      .select({ version: rawPayloads.pluginVersion })
      .from(rawPayloads)
      .where(eq(rawPayloads.deviceId, device.id));
    expect(archived.map((a) => a.version)).toContain('1.5.1');
  });

  it('401 for a missing or unknown token', async () => {
    expect((await send(fixture('snapshot-normal'), { token: null })).status).toBe(401);
    const res = await send(fixture('snapshot-normal'), { token: 'f'.repeat(64) });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: 'unauthorized' });
  });

  it('400 plugin_outdated for an old plugin', async () => {
    const res = await send(fixture('snapshot-normal'), { version: '1.4' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'plugin_outdated' });
  });

  it('413 for a chunked body over INGEST_MAX_BODY_KB (256 KiB), enforced while streaming', async () => {
    const res = await send(chunkedBody(256 * 1024 + 1));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ ok: false, error: 'payload_too_large' });
    // And from a declared Content-Length alone.
    const declared = await send('{}', { headers: { 'content-length': String(300 * 1024) } });
    expect(declared.status).toBe(413);
  });

  it('accepts a body of exactly the cap (then 400: it is not JSON)', async () => {
    const res = await send(chunkedBody(256 * 1024));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'invalid_json' });
  });

  it('429 with an integer Retry-After once a device exceeds its bucket (PLUGIN-5)', async () => {
    const noisy = await ctx.seedDevice(await ctx.seedUser());
    let res: Response | undefined;
    for (let i = 0; i < 40; i++) {
      res = await send('{', { token: noisy.token });
      if (res.status === 429) break;
      expect(res.status).toBe(400);
    }
    expect(res?.status).toBe(429);
    expect(res?.headers.get('retry-after')).toBe('3');
  });
});

describe('GET/HEAD /api/osrs-data/events', () => {
  it('answers 400 with the "enter the exact URL" text, never a redirect (PLUGIN-2)', async () => {
    // What a 301 turns the plugin's POST into: a body-less GET that still carries the token.
    const res = await GET(
      ctx.request('/api/osrs-data/events', {
        headers: { 'x-osrs-token': device.token, 'x-osrs-exporter-version': '1.5' },
        sameOrigin: false,
      }),
    );
    expect(res.status).toBe(400);
    expect(res.headers.get('location')).toBeNull();
    expect(await res.json()).toEqual({ ok: false, error: PLUGIN_GET_ERROR });

    const head = await HEAD(ctx.request('/api/osrs-data/events', { method: 'HEAD' }));
    expect(head.status).toBe(400);
    expect(await head.text()).toBe('');
  });

  it("logs a paired device's redirected GET with its id, never the token; strangers' GETs not at all", async () => {
    const warn = vi.spyOn(getLogger(), 'warn');
    try {
      const get = (token: string) =>
        GET(
          ctx.request('/api/osrs-data/events', {
            headers: { 'x-osrs-token': token },
            sameOrigin: false,
          }),
        );
      // Anyone can send these: an unknown token must not be able to fill the log.
      for (let i = 0; i < 5; i++) expect((await get(`made-up-${i}`)).status).toBe(400);
      expect((await get(device.token)).status).toBe(400);
      const logged = () => warn.mock.calls.map((c) => c[0] as { deviceId?: string | null });
      await vi.waitFor(() => expect(logged().some((l) => l.deviceId === device.id)).toBe(true));
      await new Promise((r) => setTimeout(r, 50));
      expect(logged().filter((l) => l.deviceId !== device.id)).toEqual([]);
      expect(logged().find((l) => l.deviceId === device.id)).toMatchObject({ endpoint: 'events' });
      expect(JSON.stringify(warn.mock.calls)).not.toContain(device.token);
    } finally {
      warn.mockRestore();
    }
  });
});

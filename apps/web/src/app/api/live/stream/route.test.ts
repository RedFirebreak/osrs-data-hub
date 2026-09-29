import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { events, osrsAccounts, session } from '@hub/db';
import {
  CHANNELS,
  REPLAY_DEFAULT_LIMIT,
  SSE_HEARTBEAT_MS,
  ensureLiveListener,
  getLiveHub,
  type LiveEventMessage,
} from '@hub/server';
import { desc, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { POST as ingestPOST } from '@/app/api/osrs-data/events/route';
import { readUntil, withTestDb, type WebTestContext } from '@/lib/test-utils';
import { GET } from './route';

const FIXTURE_DIR = path.resolve(
  import.meta.dirname,
  '../../../../../../../packages/fixtures/payloads',
);

let ctx: WebTestContext;
let userId: string;
let cookie: string;
/** Streams opened by a test; aborted afterwards so none outlives it. */
const open: AbortController[] = [];

beforeAll(async () => {
  ctx = await withTestDb({ label: 'livestream' });
  userId = await ctx.seedUser();
  cookie = await ctx.signIn(userId);
});
afterEach(() => {
  for (const c of open.splice(0)) c.abort();
});
afterAll(() => ctx.cleanup());

async function openStream(headers: Record<string, string> = {}, query = '') {
  const abort = new AbortController();
  open.push(abort);
  const res = await GET(
    ctx.request(`/api/live/stream${query}`, { cookie, headers, signal: abort.signal }),
  );
  expect(res.status).toBe(200);
  const reader = res.body!.getReader();
  return { res, reader, abort };
}

/** Reads until the stream ends; throws when it is still open after `timeoutMs`. */
async function readToEnd(reader: ReadableStreamDefaultReader<Uint8Array>, timeoutMs = 5_000) {
  let text = '';
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), Math.max(0, deadline - Date.now()));
    });
    const next = await Promise.race([reader.read(), timeout]);
    clearTimeout(timer);
    if (next === 'timeout') throw new Error(`stream still open; got ${JSON.stringify(text)}`);
    if (next.done) return text;
    text += decoder.decode(next.value, { stream: true });
  }
}

/** Posts a fixture through the real ingest route with a device of `owner`. */
async function ingestFixture(token: string, name: string) {
  const body = readFileSync(path.join(FIXTURE_DIR, `${name}.json`), 'utf8');
  const res = await ingestPOST(
    ctx.request('/api/osrs-data/events', {
      method: 'POST',
      body,
      headers: { 'x-osrs-token': token, 'x-osrs-exporter-version': '1.5' },
      sameOrigin: false,
    }),
  );
  expect(res.status).toBe(200);
}

describe('GET /api/live/stream', () => {
  it('401 JSON without a session', async () => {
    const res = await GET(ctx.request('/api/live/stream'));
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(getLiveHub().size()).toBe(0);
  });

  it('streams SSE: hello, pairing messages, and unsubscribes on abort', async () => {
    const { res, reader, abort } = await openStream();
    expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-cache, no-transform');
    expect(res.headers.get('x-accel-buffering')).toBe('no');
    expect(res.headers.get('connection')).toBe('keep-alive');

    expect(await readUntil(reader, (t) => t.includes(': connected'))).toMatch(/^retry: \d+\n/);
    expect(getLiveHub().size()).toBe(1);

    // Directly through the hub: only this user's streams get their pairing messages.
    const codeId = randomUUID();
    const deviceId = randomUUID();
    getLiveHub().onPairing({ kind: 'consumed', userId: 'someone-else', codeId, deviceId });
    getLiveHub().onPairing({ kind: 'consumed', userId, codeId, deviceId });
    const text = await readUntil(reader, (t) => t.includes('event: pairing'));
    expect(text).toContain(
      `data: {"kind":"consumed","codeId":"${codeId}","deviceId":"${deviceId}"}`,
    );
    expect(text.match(/event: pairing/g)).toHaveLength(1);

    abort.abort();
    expect(getLiveHub().size()).toBe(0);
    await readToEnd(reader);
  });

  it('delivers a committed pg_notify through the LISTEN connection', async () => {
    const { reader } = await openStream();
    await readUntil(reader, (t) => t.includes(': connected'));
    // The route started the listener (instrumentation doesn't run in tests).
    await vi.waitFor(() => expect(ensureLiveListener().connected()).toBe(true), {
      timeout: 5_000,
    });
    const codeId = randomUUID();
    const payload = JSON.stringify({ kind: 'outdated_plugin', userId, codeId, version: '1.4' });
    await ctx.t.db.execute(sql`SELECT pg_notify(${CHANNELS.pairing}, ${payload})`);
    const text = await readUntil(reader, (t) => t.includes(codeId));
    expect(text).toContain('event: pairing');
    expect(text).toContain('"kind":"outdated_plugin"');
  });

  it('sends ingested events live with their seq as id, and replays after Last-Event-ID', async () => {
    await vi.waitFor(() => expect(ensureLiveListener().connected()).toBe(true), {
      timeout: 5_000,
    });
    const device = await ctx.seedDevice(userId);
    const live = await openStream();
    await readUntil(live.reader, (t) => t.includes(': connected'));

    await ingestFixture(device.token, 'event-loot');
    const text = await readUntil(live.reader, (t) => t.includes('event: event'));
    const [newest] = await ctx.t.db
      .select({ seq: events.seq })
      .from(events)
      .orderBy(desc(events.seq))
      .limit(1);
    expect(newest).toBeDefined();
    expect(text).toContain(`id: ${newest!.seq}\nevent: event\n`);
    const data = /event: event\ndata: (.*)\n/.exec(text)?.[1];
    const message = JSON.parse(data!) as LiveEventMessage;
    expect(message.event.type).toBe('loot');
    expect(message.event.account.name).toBe('Zezima');

    // A reconnect carrying Last-Event-ID gets what came after it replayed first.
    await ingestFixture(device.token, 'event-levelup-multi');
    const seqs = (
      await ctx.t.db.select({ seq: events.seq }).from(events).orderBy(desc(events.seq))
    ).map((e) => e.seq);
    expect(seqs.length).toBeGreaterThan(1);
    const again = await openStream({ 'last-event-id': String(newest!.seq) });
    const replayed = await readUntil(again.reader, (t) => t.includes(`id: ${seqs[0]}\n`));
    expect(replayed.indexOf(': connected')).toBeLessThan(replayed.indexOf('event: event'));
    // Nothing at or before Last-Event-ID, and ascending seqs.
    const ids = [...replayed.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
    expect(ids.every((id) => id > newest!.seq)).toBe(true);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));

    // ?lastEventId= works the same (a client reopening the stream itself).
    const viaQuery = await openStream({}, `?lastEventId=${newest!.seq}`);
    await readUntil(viaQuery.reader, (t) => t.includes(`id: ${seqs[0]}\n`));

    // A first connection never replays (it would toast old events).
    const fresh = await openStream();
    const first = await readUntil(fresh.reader, (t) => t.includes(': connected'));
    await new Promise((r) => setTimeout(r, 300));
    fresh.abort.abort();
    expect(first + (await readToEnd(fresh.reader))).not.toContain('event: event');
  });

  it('a replay cut off at its limit ends with resync, so the client refetches what it skipped', async () => {
    const [account] = await ctx.t.db
      .insert(osrsAccounts)
      .values({
        publicId: randomUUID().replace(/-/g, '').slice(0, 12),
        accountHash: randomUUID(),
        currentName: 'Busy',
        nameNormalized: 'busy',
      })
      .returning({ id: osrsAccounts.id });
    const at = new Date();
    const rows = await ctx.t.db
      .insert(events)
      .values(
        Array.from({ length: REPLAY_DEFAULT_LIMIT + 5 }, () => ({
          pluginEventId: randomUUID(),
          accountId: account!.id,
          type: 'level_up',
          skill: 'Attack',
          level: 99,
          occurredAt: at,
          receivedAt: at,
          insertedAt: at,
          data: { type: 'levelUp', data: { skills: { Attack: 99 } } },
        })),
      )
      .returning({ seq: events.seq });
    const first = Math.min(...rows.map((r) => r.seq));

    const { reader } = await openStream({ 'last-event-id': String(first - 1) });
    const text = await readUntil(reader, (t) => t.includes('event: resync'), 3_000);
    expect(text.match(/^event: event$/gm)).toHaveLength(REPLAY_DEFAULT_LIMIT);
    // The resync comes after the replayed events.
    expect(text.lastIndexOf('event: event')).toBeLessThan(text.indexOf('event: resync'));
  });

  it('ends the stream when the stream is cancelled', async () => {
    const { reader } = await openStream();
    await readUntil(reader, (t) => t.includes(': connected'));
    expect(getLiveHub().size()).toBe(1);
    await reader.cancel();
    expect(getLiveHub().size()).toBe(0);
  });

  it('heartbeats every 25 s and closes once the session is gone', async () => {
    const beats: (() => void)[] = [];
    const realSetInterval = globalThis.setInterval;
    const spy = vi.spyOn(globalThis, 'setInterval').mockImplementation(((
      fn: () => void,
      ms?: number,
    ) => {
      if (ms === SSE_HEARTBEAT_MS) {
        beats.push(fn);
        return realSetInterval(() => {}, 1 << 30);
      }
      return realSetInterval(fn, ms);
    }) as typeof setInterval);
    let reader: ReadableStreamDefaultReader<Uint8Array>;
    const otherId = await ctx.seedUser();
    const otherCookie = await ctx.signIn(otherId);
    try {
      const abort = new AbortController();
      open.push(abort);
      const res = await GET(
        ctx.request('/api/live/stream', { cookie: otherCookie, signal: abort.signal }),
      );
      reader = res.body!.getReader();
    } finally {
      spy.mockRestore();
    }
    await readUntil(reader, (t) => t.includes(': connected'));
    expect(beats).toHaveLength(1);
    const beat = beats[0]!;

    beat();
    await readUntil(reader, (t) => t.includes(': ping'));
    expect(getLiveHub().size()).toBe(1);

    // Sign-out everywhere / offboarding deletes the sessions: the next heartbeat ends the stream.
    await ctx.t.db.delete(session).where(eq(session.userId, otherId));
    beat();
    await readToEnd(reader);
    expect(getLiveHub().size()).toBe(0);
  });
});

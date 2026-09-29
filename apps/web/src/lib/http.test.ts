import { parseConfig, setConfigForTests } from '@hub/core';
import { AdminError, SharingError, silentLogger } from '@hub/server';
import { APIError } from 'better-auth/api';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ApiError,
  assertSameOrigin,
  clientIp,
  handleApi,
  isSameOrigin,
  json,
  pluginResponse,
  readBodyCapped,
  readJson,
} from './http';

const ORIGIN = 'https://hub.example.com';

function useConfig(env: Record<string, string> = {}) {
  setConfigForTests(parseConfig({ APP_URL: ORIGIN, LOG_LEVEL: 'silent', ...env }));
}

/** A request whose body arrives in the given chunks, without Content-Length (chunked). */
function chunked(chunks: Uint8Array[], headers: Record<string, string> = {}): Request {
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = chunks[i++];
      if (next) controller.enqueue(next);
      else controller.close();
    },
  });
  return new Request('http://0.0.0.0:3000/x', {
    method: 'POST',
    body,
    headers,
    duplex: 'half',
  } as RequestInit);
}

/** A body stream that counts how many chunks were pulled and whether it was cancelled. */
function tracked(chunkSize: number, count: number) {
  const state = { pulled: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (state.pulled >= count) return controller.close();
      state.pulled++;
      controller.enqueue(new Uint8Array(chunkSize).fill(0x61));
    },
    cancel() {
      state.cancelled = true;
    },
  });
  const request = new Request('http://0.0.0.0:3000/x', {
    method: 'POST',
    body,
    duplex: 'half',
  } as RequestInit);
  return { request, state };
}

const enc = (s: string) => new TextEncoder().encode(s);

beforeAll(() => {
  (globalThis as { __hubLogger?: unknown }).__hubLogger = silentLogger();
});
beforeEach(() => useConfig());
afterEach(() => setConfigForTests(undefined));

describe('json / pluginResponse', () => {
  it('sets the JSON content type and no-store', async () => {
    const res = json(201, { a: 1 });
    expect(res.status).toBe(201);
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ a: 1 });
  });

  it('copies the plugin response headers (integer Retry-After, PLUGIN-5)', async () => {
    const res = pluginResponse({
      status: 429,
      body: { ok: false, error: 'rate_limited' },
      headers: { 'Retry-After': '3' },
    });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('3');
    expect(await res.json()).toEqual({ ok: false, error: 'rate_limited' });
  });
});

describe('readBodyCapped', () => {
  it('refuses a declared Content-Length over the cap without reading', async () => {
    const { request, state } = tracked(10, 50);
    const withLength = new Request(request, { headers: { 'content-length': '500' } });
    // The stream pulls a few chunks ahead by itself; how many depends on the Node version (3 on
    // Node 22, 4 on Node 24). Let that settle and count only what reading would add on top.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const buffered = state.pulled;
    expect(buffered).toBeLessThan(10);
    expect(await readBodyCapped(withLength, 499)).toBeNull();
    expect(state.pulled).toBe(buffered);
    expect(state.cancelled).toBe(true);
  });

  it('refuses a chunked body over the cap and cancels the reader', async () => {
    const { request, state } = tracked(1024, 1000);
    expect(await readBodyCapped(request, 4096)).toBeNull();
    expect(state.cancelled).toBe(true);
    // It stopped right after passing the cap, not at the end of the body.
    expect(state.pulled).toBeLessThanOrEqual(6);
  });

  it('accepts a body of exactly the cap', async () => {
    const text = 'x'.repeat(100);
    expect(await readBodyCapped(chunked([enc(text.slice(0, 40)), enc(text.slice(40))]), 100)).toBe(
      text,
    );
    expect(await readBodyCapped(chunked([enc(text)]), 99)).toBeNull();
  });

  it('counts bytes, not characters, and decodes multi-byte UTF-8 split across chunks', async () => {
    const text = "Kree'arra 🐉 Ahrim’s robe – ÿ";
    const bytes = enc(text);
    // Split inside the 4-byte emoji and inside the 3-byte quote.
    const emoji = text.indexOf('🐉');
    const cut1 = enc(text.slice(0, emoji)).length + 2;
    const cut2 = cut1 + 5;
    const parts = [bytes.slice(0, cut1), bytes.slice(cut1, cut2), bytes.slice(cut2)];
    expect(await readBodyCapped(chunked(parts), bytes.length)).toBe(text);
    expect(await readBodyCapped(chunked([bytes]), bytes.length - 1)).toBeNull();
    expect(bytes.length).toBeGreaterThan(text.length);
  });

  it('turns invalid UTF-8 into U+FFFD instead of failing', async () => {
    const res = await readBodyCapped(chunked([new Uint8Array([0x7b, 0xff, 0x7d])]), 10);
    expect(res).toBe('{�}');
  });

  it('returns an empty string when there is no body', async () => {
    expect(await readBodyCapped(new Request('http://x/', { method: 'POST' }), 10)).toBe('');
  });

  it('ignores a malformed Content-Length and counts while reading', async () => {
    const req = new Request('http://x/', {
      method: 'POST',
      body: 'hello',
      headers: { 'content-length': 'abc' },
    });
    expect(await readBodyCapped(req, 10)).toBe('hello');
  });
});

describe('readJson', () => {
  it('parses JSON, 400 on garbage, 413 over the cap', async () => {
    const ok = new Request('http://x/', { method: 'POST', body: '{"a":1}' });
    expect(await readJson(ok)).toEqual({ a: 1 });
    const bad = new Request('http://x/', { method: 'POST', body: '{nope' });
    await expect(readJson(bad)).rejects.toMatchObject({ status: 400, code: 'invalid_json' });
    const big = new Request('http://x/', { method: 'POST', body: 'x'.repeat(20) });
    await expect(readJson(big, 10)).rejects.toMatchObject({ status: 413 });
  });
});

describe('clientIp', () => {
  const req = (xff?: string) =>
    new Request('http://x/', { headers: xff === undefined ? {} : { 'x-forwarded-for': xff } });

  it('takes the entry TRUST_PROXY_HOPS from the right', () => {
    useConfig({ TRUST_PROXY_HOPS: '1' });
    expect(clientIp(req('198.51.100.1, 203.0.113.9'))).toBe('203.0.113.9');
    useConfig({ TRUST_PROXY_HOPS: '2' });
    expect(clientIp(req('198.51.100.1, 203.0.113.9'))).toBe('198.51.100.1');
    // Fewer entries than hops: the leftmost.
    useConfig({ TRUST_PROXY_HOPS: '3' });
    expect(clientIp(req('198.51.100.1, 203.0.113.9'))).toBe('198.51.100.1');
  });

  it('is null with 0 hops, without the header, or for a non-address', () => {
    useConfig({ TRUST_PROXY_HOPS: '0' });
    expect(clientIp(req('203.0.113.9'))).toBeNull();
    useConfig({ TRUST_PROXY_HOPS: '1' });
    expect(clientIp(req())).toBeNull();
    expect(clientIp(req('unknown'))).toBeNull();
  });
});

describe('assertSameOrigin', () => {
  const req = (headers: Record<string, string>) =>
    new Request('http://0.0.0.0:3000/api/app/x', { method: 'POST', headers });

  it('passes when Origin is APP_URL', () => {
    expect(() => assertSameOrigin(req({ origin: ORIGIN }))).not.toThrow();
  });

  it('refuses another origin, a look-alike and "null"', () => {
    for (const origin of [
      'https://evil.example.com',
      'http://hub.example.com',
      'https://hub.example.com:8443',
      'https://hub.example.com.evil.net',
      'null',
    ]) {
      expect(isSameOrigin(req({ origin }))).toBe(false);
    }
    expect(() => assertSameOrigin(req({ origin: 'https://evil.example.com' }))).toThrow(ApiError);
  });

  it('never trusts Host or request.url (NEXT-2)', () => {
    // The bind address the handler sees is not the hub's origin.
    expect(isSameOrigin(req({ origin: 'http://0.0.0.0:3000', host: '0.0.0.0:3000' }))).toBe(false);
  });

  it('without Origin, needs Sec-Fetch-Site: same-origin', () => {
    expect(isSameOrigin(req({ 'sec-fetch-site': 'same-origin' }))).toBe(true);
    expect(isSameOrigin(req({ 'sec-fetch-site': 'same-site' }))).toBe(false);
    expect(isSameOrigin(req({ 'sec-fetch-site': 'cross-site' }))).toBe(false);
    expect(isSameOrigin(req({}))).toBe(false);
  });

  it('a mismatching Origin wins over Sec-Fetch-Site', () => {
    expect(
      isSameOrigin(req({ origin: 'https://evil.example.com', 'sec-fetch-site': 'same-origin' })),
    ).toBe(false);
  });
});

describe('handleApi', () => {
  const body = async (res: Response) => (await res.json()) as { error: Record<string, unknown> };

  it('passes a response through', async () => {
    const res = await handleApi(() => json(200, { ok: true }));
    expect(res.status).toBe(200);
  });

  it('maps ApiError to its status and code', async () => {
    const res = await handleApi(() => {
      throw new ApiError(409, 'conflict', 'Already done.', { 'X-Test': '1' });
    });
    expect(res.status).toBe(409);
    expect(res.headers.get('x-test')).toBe('1');
    expect(await body(res)).toEqual({ error: { code: 'conflict', message: 'Already done.' } });
  });

  it('maps SharingError and AdminError codes to 404/403/400', async () => {
    const cases = [
      [new SharingError('not_found'), 404],
      [new SharingError('forbidden', 'Not yours.'), 403],
      [new SharingError('invalid'), 400],
      [new AdminError('forbidden'), 403],
      [new AdminError('not_found'), 404],
      [new AdminError('invalid', 'You cannot offboard yourself.'), 400],
    ] as const;
    for (const [err, status] of cases) {
      const res = await handleApi(() => Promise.reject(err));
      expect(res.status).toBe(status);
      expect((await body(res)).error.code).toBe(err.code);
    }
  });

  it("maps Better Auth's APIError: 5xx → 503 + Retry-After, 401 → 401, other 4xx as they are", async () => {
    const cases = [
      [new APIError('INTERNAL_SERVER_ERROR', { code: 'FAILED_TO_GET_SESSION' }), 503],
      [new APIError('UNAUTHORIZED', { code: 'FAILED_TO_GET_SESSION' }), 401],
      [new APIError('BAD_REQUEST', { message: 'nope' }), 400],
    ] as const;
    for (const [err, status] of cases) {
      const res = await handleApi(() => Promise.reject(err));
      expect(res.status).toBe(status);
      expect(res.headers.get('retry-after')).toBe(status === 503 ? '5' : null);
    }
  });

  it('maps ZodError to 400 with field errors', async () => {
    const res = await handleApi(() => {
      z.strictObject({ timezone: z.string() }).parse({ timezone: 5 });
      return json(200, {});
    });
    expect(res.status).toBe(400);
    const { error } = await body(res);
    expect(error.code).toBe('invalid_request');
    expect(error.details).toEqual([{ path: 'timezone', message: expect.any(String) as string }]);
  });

  it('maps a transient database error (lock timeout) to 503 + Retry-After', async () => {
    const pgErr = Object.assign(new Error('canceling statement due to lock timeout'), {
      code: '55P03',
    });
    const wrapped = new Error('Failed query: update … params: secret-token', { cause: pgErr });
    const res = await handleApi(() => Promise.reject(wrapped));
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toMatch(/^\d+$/);
    expect(JSON.stringify(await body(res))).not.toContain('secret-token');
  });

  it('maps a data error from the database to 400', async () => {
    const pgErr = Object.assign(new Error('invalid input syntax for type uuid'), { code: '22P02' });
    const res = await handleApi(() => Promise.reject(new Error('Failed query', { cause: pgErr })));
    expect(res.status).toBe(400);
  });

  it('answers anything else 500 without leaking the message', async () => {
    const res = await handleApi(() => {
      throw new Error('internal detail: password=hunter2');
    });
    expect(res.status).toBe(500);
    const text = JSON.stringify(await body(res));
    expect(text).toContain('internal_error');
    expect(text).not.toContain('hunter2');
  });
});

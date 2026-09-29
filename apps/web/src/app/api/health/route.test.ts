import type { DbHandle } from '@hub/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withTestDb, type WebTestContext } from '@/lib/test-utils';
import { GET } from './route';

// connection() needs a Next request scope; the route runs bare here.
vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  connection: () => Promise.resolve(),
}));

const g = globalThis as unknown as { __hubDb?: DbHandle };

let ctx: WebTestContext;

beforeAll(async () => {
  ctx = await withTestDb({ label: 'health' });
});
afterAll(() => ctx.cleanup());

describe('GET /api/health', () => {
  it('200 {"ok":true} when the database answers', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ ok: true });
  });

  it('503 {"ok":false} when the database is unreachable, within about 2 s', async () => {
    const testDb = g.__hubDb;
    const url = process.env.DATABASE_URL;
    delete g.__hubDb;
    // Nothing listens on port 1: the connection is refused.
    process.env.DATABASE_URL = 'postgres://hub:hub@127.0.0.1:1/nope';
    try {
      const started = Date.now();
      const res = await GET();
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ ok: false });
      expect(Date.now() - started).toBeLessThan(3_000);
    } finally {
      // The pool getDb() created for the bad URL (TS narrowed __hubDb after the delete).
      await (g.__hubDb as DbHandle | undefined)?.pool.end().catch(() => {});
      g.__hubDb = testDb;
      process.env.DATABASE_URL = url;
    }
  });

  it('503 when DATABASE_URL is not set at all', async () => {
    const testDb = g.__hubDb;
    const url = process.env.DATABASE_URL;
    delete g.__hubDb;
    delete process.env.DATABASE_URL;
    try {
      expect((await GET()).status).toBe(503);
    } finally {
      g.__hubDb = testDb;
      process.env.DATABASE_URL = url;
    }
  });
});

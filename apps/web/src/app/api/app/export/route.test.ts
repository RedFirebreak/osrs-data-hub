/**
 * GET /api/app/export (D-79): same origin only, session auth, one export per user per 10 minutes,
 * the attachment headers, the streamed document, the audit entry, and what happens when the
 * download is cancelled or the export fails half-way.
 */
import { auditLog, events, osrsAccounts, users } from '@hub/db';
import type * as Server from '@hub/server';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { withTestDb, type WebTestContext } from '@/lib/test-utils';
import { setExportLimiterForTests } from './limits';
import { GET } from './route';

vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  connection: () => Promise.resolve(),
}));

/** Wraps the real exportUserData to fail after `failAfter` pieces and count finished generators. */
const control = vi.hoisted(() => ({ failAfter: null as number | null, finished: 0 }));

vi.mock('@hub/server', async (importOriginal) => {
  const real = await importOriginal<typeof Server>();
  return {
    ...real,
    exportUserData: (...args: Parameters<typeof real.exportUserData>) => {
      const inner = real.exportUserData(...args);
      return (async function* () {
        let n = 0;
        try {
          for await (const piece of inner) {
            if (control.failAfter !== null && n >= control.failAfter) {
              // Shaped like a drizzle query error: the message lists the bound parameters (DB-3).
              const pgErr = Object.assign(new Error('terminating connection'), { code: '57P01' });
              throw new Error('Failed query: select … params: secret-param', { cause: pgErr });
            }
            n++;
            yield piece;
          }
        } finally {
          control.finished++;
        }
      })();
    },
  };
});

let ctx: WebTestContext;
const g = globalThis as unknown as { __hubLogger?: unknown };

beforeAll(async () => {
  ctx = await withTestDb({ label: 'appexport' });
});
beforeEach(() => {
  setExportLimiterForTests();
  control.failAfter = null;
});
afterAll(async () => {
  setExportLimiterForTests();
  await ctx.cleanup();
});

async function signedIn(): Promise<{ userId: string; cookie: string }> {
  const userId = await ctx.seedUser({ name: 'Exporter' });
  return { userId, cookie: await ctx.signIn(userId) };
}

function get(
  cookie: string | undefined,
  opts: { headers?: Record<string, string>; sameOrigin?: boolean } = {},
): Promise<Response> {
  return GET(
    ctx.request('/api/app/export', {
      cookie,
      headers: opts.headers,
      sameOrigin: opts.sameOrigin ?? true,
    }),
  );
}

async function seedOwnedAccount(userId: string): Promise<string> {
  const publicId = `pub${Math.random().toString(36).slice(2, 11)}`;
  const [account] = await ctx.t.db
    .insert(osrsAccounts)
    .values({
      publicId,
      accountHash: publicId,
      currentName: 'Zezima',
      nameNormalized: 'zezima',
      ownerUserId: userId,
    })
    .returning({ id: osrsAccounts.id });
  await ctx.t.db.insert(events).values({
    accountId: account!.id,
    pluginEventId: 'e1',
    type: 'loot',
    occurredAt: new Date(),
    receivedAt: new Date(),
    valueGp: 1000,
    data: { type: 'loot', data: {}, eventId: 'e1', timestamp: 0 },
  });
  return publicId;
}

describe('GET /api/app/export', () => {
  it('streams the JSON document as a dated attachment and audits it', async () => {
    const { userId, cookie } = await signedIn();
    const publicId = await seedOwnedAccount(userId);

    const res = await get(cookie);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-disposition')).toMatch(
      /^attachment; filename="osrs-data-hub-export-\d{4}-\d{2}-\d{2}\.json"$/,
    );
    // Audited before the response went out.
    const audited = await ctx.t.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'user.exported'), eq(auditLog.actorUserId, userId)));
    expect(audited).toEqual([
      expect.objectContaining({ targetType: 'user', targetId: userId, meta: { accounts: 1 } }),
    ]);
    const doc = JSON.parse(await res.text()) as Record<string, unknown>;
    expect(doc).toMatchObject({
      format: 'osrs-data-hub-export',
      version: 1,
      hub: { name: 'Test Hub', url: 'http://hub.test' },
      user: { id: userId, name: 'Exporter' },
      accounts: [{ id: publicId, name: 'Zezima', relation: 'owner', events: [{ value_gp: 1000 }] }],
    });
  });

  it('answers 401 when signed out, and 401 for a user in grace', async () => {
    expect((await get(undefined)).status).toBe(401);
    const userId = await ctx.seedUser({ status: 'grace' });
    expect((await get(await ctx.signIn(userId))).status).toBe(401);
  });

  it('allows a same-origin download link and refuses other sites (403)', async () => {
    const { cookie } = await signedIn();
    const link = await get(cookie, {
      sameOrigin: false,
      headers: { 'sec-fetch-site': 'same-origin' },
    });
    expect(link.status).toBe(200);
    await link.body?.cancel();
    const refused: Record<string, string>[] = [
      { 'sec-fetch-site': 'cross-site' },
      {},
      { origin: 'https://evil.example' },
    ];
    for (const headers of refused) {
      const res = await get(cookie, { sameOrigin: false, headers });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('bad_origin');
    }
  });

  it('allows one export per user per 10 minutes (429 with an integer Retry-After)', async () => {
    const { cookie } = await signedIn();
    const first = await get(cookie);
    expect(first.status).toBe(200);
    await first.text();

    const second = await get(cookie);
    expect(second.status).toBe(429);
    expect(second.headers.get('retry-after')).toMatch(/^(600|599)$/);
    expect(((await second.json()) as { error: { code: string } }).error.code).toBe('rate_limited');

    const other = await signedIn();
    const res = await get(other.cookie);
    expect(res.status).toBe(200);
    await res.text();
  });

  it('stops the export when the download is cancelled', async () => {
    const { userId, cookie } = await signedIn();
    await seedOwnedAccount(userId);
    const finished = control.finished;
    const res = await get(cookie);
    const reader = res.body!.getReader();
    const { done } = await reader.read();
    expect(done).toBe(false);
    await reader.cancel();
    expect(control.finished).toBe(finished + 1);
  });

  it('breaks the download, instead of ending the JSON, when the export fails half-way', async () => {
    const { userId, cookie } = await signedIn();
    await seedOwnedAccount(userId);
    const lines: Record<string, unknown>[] = [];
    const previous = g.__hubLogger;
    const record = (obj: Record<string, unknown>, msg: string) => void lines.push({ ...obj, msg });
    g.__hubLogger = { error: record, warn: record, info: record, debug: record };
    try {
      control.failAfter = 3;
      const res = await get(cookie);
      expect(res.status).toBe(200);
      await expect(res.text()).rejects.toThrow();
    } finally {
      g.__hubLogger = previous;
    }
    const line = lines.find((l) => l.msg === 'export: failed while streaming');
    expect(line).toMatchObject({ userId, pgCode: '57P01', error: 'terminating connection' });
    expect(JSON.stringify(lines)).not.toContain('secret-param');
  });

  it('answers an early failure with an error response, not a broken 200', async () => {
    const { userId, cookie } = await signedIn();
    control.failAfter = 0;
    const res = await get(cookie);
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('5');
    // Nothing about the user changed.
    const [row] = await ctx.t.db.select().from(users).where(eq(users.id, userId));
    expect(row?.status).toBe('active');
  });
});

import { createDb } from '@hub/db';
import { createTestDatabase, type TestDatabase } from '@hub/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pingDatabase } from './health';

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase('health');
});
afterAll(async () => {
  await t.drop();
});

describe('pingDatabase', () => {
  it('resolves against a reachable database', async () => {
    await expect(pingDatabase(t.db, 2_000)).resolves.toBeUndefined();
  });

  it('rejects when the database is unreachable', async () => {
    // Nothing listens on port 1.
    const down = createDb('postgres://hub:hub@127.0.0.1:1/nope', { max: 1 });
    try {
      await expect(pingDatabase(down.db, 2_000)).rejects.toThrow();
    } finally {
      await down.pool.end().catch(() => {});
    }
  });

  it('rejects after the timeout when the query hangs', async () => {
    const hanging = { execute: () => new Promise(() => {}) } as unknown as Parameters<
      typeof pingDatabase
    >[0];
    await expect(pingDatabase(hanging, 20)).rejects.toThrow('database ping timed out');
  });
});

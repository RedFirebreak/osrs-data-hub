/**
 * The constant-time path of authenticateApiKey: an unknown prefix and a wrong secret both hash the
 * secret and run one constant-time comparison against a 64-character hash, so neither timing nor the
 * answer tells whether a prefix exists. Its own file: @hub/core's constantTimeEqual is spied on.
 */
import type * as core from '@hub/core';
import { sha256Hex } from '@hub/core';
import { createTestDatabase, type TestDatabase } from '@hub/db/testing';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { seedUser } from '../accounts/test-support';
import { authenticateApiKey } from './key-auth';
import { createApiKey } from './keys';

const spy = vi.hoisted(() => ({ calls: [] as [string, string][] }));

vi.mock('@hub/core', async (importOriginal) => {
  const actual = await importOriginal<typeof core>();
  return {
    ...actual,
    constantTimeEqual: (a: string, b: string) => {
      spy.calls.push([a, b]);
      return actual.constantTimeEqual(a, b);
    },
  };
});

let t: TestDatabase;
let key: string;
let prefix: string;
let secret: string;

beforeAll(async () => {
  t = await createTestDatabase('api-keys-timing');
  const user = await seedUser(t.db);
  ({ key } = await createApiKey(t.db, user.id, {
    name: 'k',
    categories: ['stats'],
    accountScope: 'all_visible',
  }));
  const [, p, s] = /^ohub_([0-9A-Za-z]{10})_([0-9A-Za-z]{43})$/.exec(key) ?? [];
  prefix = p as string;
  secret = s as string;
});

afterAll(async () => {
  await t.drop();
});

beforeEach(() => {
  spy.calls.length = 0;
});

const flip = (s: string) => `${s.slice(0, -1)}${s.endsWith('A') ? 'B' : 'A'}`;

it('compares once, in constant time, for an unknown prefix', async () => {
  const other = flip(secret);
  const result = await authenticateApiKey(t.db, `Bearer ohub_${flip(prefix)}_${other}`);
  expect(result).toEqual({ ok: false, reason: 'unknown' });
  expect(spy.calls).toHaveLength(1);
  const [given, stored] = spy.calls[0] ?? [];
  expect(given).toBe(sha256Hex(other));
  expect(stored).toMatch(/^[0-9a-f]{64}$/);
});

it('compares once, in constant time, for a wrong secret', async () => {
  const other = flip(secret);
  const result = await authenticateApiKey(t.db, `Bearer ohub_${prefix}_${other}`);
  expect(result).toEqual({ ok: false, reason: 'unknown' });
  expect(spy.calls).toEqual([[sha256Hex(other), sha256Hex(secret)]]);
});

it('compares once for the right key', async () => {
  expect((await authenticateApiKey(t.db, `Bearer ${key}`)).ok).toBe(true);
  expect(spy.calls).toEqual([[sha256Hex(secret), sha256Hex(secret)]]);
});

it('does not compare at all for a malformed header', async () => {
  expect(await authenticateApiKey(t.db, `Bearer ${key}x`)).toEqual({
    ok: false,
    reason: 'malformed',
  });
  expect(spy.calls).toHaveLength(0);
});

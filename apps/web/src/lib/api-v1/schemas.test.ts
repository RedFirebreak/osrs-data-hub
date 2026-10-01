/**
 * Query parsing of API v1 (schemas.ts): comma-separated lists (trimmed, deduplicated, capped with the
 * server's numbers), ISO-8601 instants, booleans, whole numbers, the opaque cursor, unknown
 * parameters ignored, and the account id pattern agreeing with the server's.
 */
import {
  EVENTS_MAX_LIMIT,
  MAX_LIST_PARAM,
  MAX_XP_ACCOUNTS,
  MAX_XP_ACCOUNTS_SERVICE,
  encodeEventsCursor,
  isPublicIdLike,
} from '@hub/server';
import { describe, expect, it } from 'vitest';
import {
  AccountPath,
  AccountsQuery,
  EventsQuery,
  GainsQuery,
  HistoryQuery,
  SnapshotQuery,
  XpMultiQuery,
  XpQuery,
} from './schemas';

const list = (n: number, prefix = 'a') => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

describe('comma-separated lists', () => {
  it('split, trim and deduplicate, keeping the first occurrence', () => {
    expect(AccountsQuery.parse({ names: ' Zezima ,Lynx Titan,Zezima' })).toEqual({
      names: ['Zezima', 'Lynx Titan'],
    });
    expect(XpQuery.parse({ skills: 'attack,defence,attack' }).skills).toEqual([
      'attack',
      'defence',
    ]);
  });

  it('treat an empty value as an empty list and refuse empty entries', () => {
    expect(EventsQuery.parse({ types: '' }).types).toEqual([]);
    expect(EventsQuery.safeParse({ types: 'loot,,death' }).success).toBe(false);
    expect(XpMultiQuery.safeParse({ accounts: '' }).success).toBe(false);
  });

  it('are capped with the server’s limits, counted after deduplication', () => {
    expect(AccountsQuery.safeParse({ ids: list(MAX_LIST_PARAM).join(',') }).success).toBe(true);
    expect(AccountsQuery.safeParse({ ids: list(MAX_LIST_PARAM + 1).join(',') }).success).toBe(
      false,
    );
    // Bulk lists are parsed up to the service keys' cap (D-92); the read model applies the user
    // keys' lower one, so the same route can serve both kinds.
    const dupes = [...list(MAX_XP_ACCOUNTS_SERVICE), ...list(MAX_XP_ACCOUNTS_SERVICE)].join(',');
    expect(XpMultiQuery.parse({ accounts: dupes }).accounts).toHaveLength(MAX_XP_ACCOUNTS_SERVICE);
    expect(
      XpMultiQuery.parse({ accounts: list(MAX_XP_ACCOUNTS + 1).join(',') }).accounts,
    ).toHaveLength(MAX_XP_ACCOUNTS + 1);
    expect(
      XpMultiQuery.safeParse({ accounts: list(MAX_XP_ACCOUNTS_SERVICE + 1).join(',') }).success,
    ).toBe(false);
  });

  it('check account ids against the public id pattern', () => {
    const issues = AccountsQuery.safeParse({ ids: 'abc,bad!id' }).error?.issues ?? [];
    expect(issues.map((i) => i.path.join('.'))).toEqual(['ids.1']);
  });
});

describe('instants', () => {
  it('accept ISO-8601 date-times with Z or an offset', () => {
    expect(HistoryQuery.parse({ from: '2026-09-29T10:00:00Z' }).from).toEqual(
      new Date('2026-09-29T10:00:00Z'),
    );
    expect(HistoryQuery.parse({ to: '2026-09-29T12:00:00.5+02:00' }).to).toEqual(
      new Date('2026-09-29T10:00:00.500Z'),
    );
    expect(SnapshotQuery.parse({ since: '2026-09-29T10:00:00Z' }).since).toBeInstanceOf(Date);
  });

  it('refuse dates alone, epoch numbers and free text', () => {
    for (const value of ['2026-09-29', '1790000000000', 'yesterday', '2026-09-29T10:00:00']) {
      expect(HistoryQuery.safeParse({ from: value }).success, value).toBe(false);
    }
  });
});

describe('other parameters', () => {
  it('online is true or false', () => {
    expect(AccountsQuery.parse({ online: 'true' }).online).toBe(true);
    expect(AccountsQuery.parse({ online: 'false' }).online).toBe(false);
    expect(AccountsQuery.safeParse({ online: '1' }).success).toBe(false);
  });

  it('limit and min_value are plain whole numbers in range', () => {
    expect(EventsQuery.parse({ limit: '25', min_value: '0' })).toMatchObject({
      limit: 25,
      min_value: 0,
    });
    expect(EventsQuery.parse({ limit: String(EVENTS_MAX_LIMIT) }).limit).toBe(EVENTS_MAX_LIMIT);
    for (const limit of ['0', String(EVENTS_MAX_LIMIT + 1), '1e2', '-5', ' 7', '3.5']) {
      expect(EventsQuery.safeParse({ limit }).success, limit).toBe(false);
    }
  });

  it('cursor is `now` or a cursor from the feed', () => {
    expect(EventsQuery.parse({ cursor: 'now' }).cursor).toBe('now');
    const cursor = encodeEventsCursor(42);
    expect(EventsQuery.parse({ cursor }).cursor).toBe(cursor);
    expect(EventsQuery.safeParse({ cursor: 'NOW' }).success).toBe(false);
    expect(EventsQuery.safeParse({ cursor: 'djE6LTE' }).success).toBe(false);
  });

  it('enums: resolution and period', () => {
    expect(XpQuery.parse({ resolution: '1h' }).resolution).toBe('1h');
    expect(XpQuery.safeParse({ resolution: '1m' }).success).toBe(false);
    expect(GainsQuery.parse({ period: 'year' }).period).toBe('year');
    expect(GainsQuery.safeParse({ period: 'decade' }).success).toBe(false);
  });

  it('ignores unknown parameters', () => {
    expect(EventsQuery.parse({ limit: '5', future: 'x' })).toEqual({ limit: 5 });
  });
});

describe('account ids', () => {
  it('match what the server accepts as a public id', () => {
    for (const id of [
      '4fT9kQ2mXa7B',
      'a',
      'x'.repeat(64),
      'x'.repeat(65),
      'bad!id',
      '',
      'a\u0000b',
    ]) {
      expect(AccountPath.safeParse({ id }).success, id).toBe(isPublicIdLike(id));
    }
  });
});

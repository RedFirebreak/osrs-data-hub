import type { OnlineEntry, PresenceMessage } from '@hub/server';
import { describe, expect, it } from 'vitest';
import {
  SeenIds,
  applyPresence,
  expirePresence,
  liveIsNewer,
  mergeOnlineNow,
  parseLiveData,
  parseSeq,
  presenceFromMessage,
  toastShowsAge,
  type LivePresence,
} from './live-state';
import { feedEvent } from './test-fixtures';

function presence(overrides: Partial<PresenceMessage> = {}): PresenceMessage {
  return {
    account: { publicId: 'AbCdEf123456', name: 'Zezima', accountType: 1 },
    online: true,
    world: 302,
    specialWorld: false,
    lastSeen: '2026-09-29T10:00:00.000Z',
    onlineForMs: 60_000,
    ...overrides,
  };
}

describe('parseLiveData', () => {
  it('parses an event message and defaults toast to false', () => {
    const event = feedEvent();
    expect(parseLiveData('event', JSON.stringify({ event, toast: true }))).toEqual({
      event,
      toast: true,
    });
    expect(parseLiveData('event', JSON.stringify({ event }))).toEqual({ event, toast: false });
  });

  it('rejects malformed JSON and events without the fields the UI needs', () => {
    expect(parseLiveData('event', '{')).toBeNull();
    expect(parseLiveData('event', 'null')).toBeNull();
    const { line: _line, ...noLine } = feedEvent();
    expect(parseLiveData('event', JSON.stringify({ event: noLine, toast: true }))).toBeNull();
    expect(
      parseLiveData('event', JSON.stringify({ event: { ...feedEvent(), seq: 'x' }, toast: true })),
    ).toBeNull();
  });

  it('normalizes presence messages', () => {
    const raw = {
      account: { publicId: 'p1', name: 'Zezima' },
      online: true,
      world: 'x',
      lastSeen: '2026-09-29T10:00:00.000Z',
      onlineForMs: -5,
    };
    expect(parseLiveData('presence', JSON.stringify(raw))).toEqual({
      account: { publicId: 'p1', name: 'Zezima', accountType: null },
      online: true,
      world: null,
      specialWorld: false,
      lastSeen: '2026-09-29T10:00:00.000Z',
      onlineForMs: 0,
    });
    expect(parseLiveData('presence', JSON.stringify({ online: true }))).toBeNull();
  });

  it('passes pairing and device objects through and ignores resync data', () => {
    const pairing = { kind: 'consumed', codeId: 'c', deviceId: 'd' };
    expect(parseLiveData('pairing', JSON.stringify(pairing))).toEqual(pairing);
    expect(parseLiveData('device', '[1]')).toBeNull();
    expect(parseLiveData('resync', '{"x":1}')).toEqual({});
  });
});

describe('parseSeq', () => {
  it('accepts positive safe integers as numbers or strings', () => {
    expect(parseSeq('42')).toBe(42);
    expect(parseSeq(' 7 ')).toBe(7);
    expect(parseSeq(3)).toBe(3);
    expect(parseSeq('0')).toBeNull();
    expect(parseSeq('')).toBeNull();
    expect(parseSeq('1e3')).toBeNull();
    expect(parseSeq(-1)).toBeNull();
    expect(parseSeq(1.5)).toBeNull();
  });
});

describe('SeenIds', () => {
  it('reports duplicates and forgets the oldest past its size', () => {
    const seen = new SeenIds(2);
    expect(seen.add('a')).toBe(true);
    expect(seen.add('a')).toBe(false);
    expect(seen.add('b')).toBe(true);
    expect(seen.add('c')).toBe(true);
    expect(seen.has('a')).toBe(false);
    expect(seen.has('b') && seen.has('c')).toBe(true);
  });
});

describe('presence bookkeeping', () => {
  it('expires online after onlineForMs, measured on the client clock', () => {
    const p = presenceFromMessage(presence({ onlineForMs: 90_000 }), 1_000);
    expect(p).toMatchObject({ online: true, onlineUntil: 91_000 });
    expect(presenceFromMessage(presence({ online: false, onlineForMs: 0 }), 1_000)).toMatchObject({
      online: false,
      onlineUntil: null,
    });
    // Online with no time left counts as offline.
    expect(presenceFromMessage(presence({ onlineForMs: 0 }), 1_000).online).toBe(false);
  });

  it('applies messages immutably and expires only when due', () => {
    const empty: ReadonlyMap<string, LivePresence> = new Map();
    const map = applyPresence(empty, presence({ onlineForMs: 60_000 }), 0);
    expect(empty.size).toBe(0);
    expect(map.get('AbCdEf123456')?.online).toBe(true);
    // Not yet due: the same map comes back (a React setter bails out).
    expect(expirePresence(map, 'AbCdEf123456', 59_999)).toBe(map);
    expect(expirePresence(map, 'unknown', 99_999)).toBe(map);
    const expired = expirePresence(map, 'AbCdEf123456', 60_000);
    expect(expired).not.toBe(map);
    expect(expired.get('AbCdEf123456')).toMatchObject({ online: false, onlineUntil: null });
    expect(map.get('AbCdEf123456')?.online).toBe(true);
    // A newer message moved the deadline: an old timer firing changes nothing.
    const renewed = applyPresence(map, presence({ onlineForMs: 60_000 }), 30_000);
    expect(expirePresence(renewed, 'AbCdEf123456', 60_000)).toBe(renewed);
  });

  it('compares live and server state by lastSeen', () => {
    const live = presenceFromMessage(presence({ lastSeen: '2026-09-29T10:00:00.000Z' }), 0);
    expect(liveIsNewer(live, '2026-09-29T09:59:59.000Z')).toBe(true);
    expect(liveIsNewer(live, '2026-09-29T10:00:00.000Z')).toBe(true);
    expect(liveIsNewer(live, '2026-09-29T10:00:01.000Z')).toBe(false);
    expect(liveIsNewer(live, null)).toBe(true);
  });
});

describe('mergeOnlineNow', () => {
  const entry = (publicId: string, name: string, lastSeen: string): OnlineEntry => ({
    publicId,
    name,
    accountType: null,
    world: 301,
    specialWorld: false,
    lastSeen,
  });
  const live = (
    publicId: string,
    name: string,
    online: boolean,
    lastSeen: string,
  ): [string, LivePresence] => [
    publicId,
    presenceFromMessage(
      presence({
        account: { publicId, name, accountType: 2 },
        online,
        lastSeen,
        onlineForMs: online ? 60_000 : 0,
      }),
      0,
    ),
  ];

  it('keeps the server list when nothing live arrived, sorted by name', () => {
    const rows = mergeOnlineNow(
      [entry('b', 'zezima', 'T10'), entry('a', 'Alice', 'T10')],
      new Map(),
    );
    expect(rows.map((r) => r.name)).toEqual(['Alice', 'zezima']);
  });

  it('adds accounts that came online and removes those that went offline or expired', () => {
    const initial = [
      entry('gone', 'Gone', '2026-09-29T10:00:00.000Z'),
      entry('stays', 'Stays', '2026-09-29T10:00:00.000Z'),
    ];
    const map = new Map([
      live('gone', 'Gone', false, '2026-09-29T10:01:00.000Z'),
      live('new', 'Newcomer', true, '2026-09-29T10:01:00.000Z'),
      live('off', 'Offline', false, '2026-09-29T10:01:00.000Z'),
    ]);
    const rows = mergeOnlineNow(initial, map);
    expect(rows.map((r) => r.publicId)).toEqual(['new', 'stays']);
    expect(rows[0]).toMatchObject({ name: 'Newcomer', accountType: 2, world: 302 });
  });

  it('prefers a server entry that is newer than the live one', () => {
    const rows = mergeOnlineNow(
      [entry('x', 'X', '2026-09-29T10:05:00.000Z')],
      new Map([live('x', 'X', false, '2026-09-29T10:00:00.000Z')]),
    );
    expect(rows.map((r) => r.publicId)).toEqual(['x']);
  });
});

describe('toastShowsAge', () => {
  it('shows the age from one minute on', () => {
    const at = '2026-09-29T10:00:00.000Z';
    const t = Date.parse(at);
    expect(toastShowsAge(at, t + 59_999)).toBe(false);
    expect(toastShowsAge(at, t + 60_000)).toBe(true);
    expect(toastShowsAge('nope', t)).toBe(false);
  });
});

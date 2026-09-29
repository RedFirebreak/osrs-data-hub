import { fixtureJson } from '@hub/fixtures';
import { describe, expect, it } from 'vitest';
import {
  EVENT_CLAMP_MS,
  LOCATION_BUCKET_MS,
  LOCATION_STALE_MS,
  TOAST_MAX_AGE_MS,
  XP_BUCKET_MS,
  clampEventTime,
  floorTo,
  isStaleSnapshot,
  payloadTime,
  utcDay,
} from './time';

const recv = new Date('2026-09-21T13:40:00.000Z');
const R = recv.getTime();

describe('constants', () => {
  it('match the handoff (§7.3, §9, §11, §13)', () => {
    expect(XP_BUCKET_MS).toBe(5 * 60_000);
    expect(LOCATION_BUCKET_MS).toBe(60_000);
    expect(EVENT_CLAMP_MS).toBe(15 * 60_000);
    expect(TOAST_MAX_AGE_MS).toBe(15 * 60_000);
    expect(LOCATION_STALE_MS).toBe(2 * 60_000);
  });
});

describe('payloadTime', () => {
  it('is the root timestamp when it is in the past', () => {
    expect(payloadTime(R - 5000, recv)).toEqual(new Date(R - 5000));
    expect(payloadTime(R, recv)).toEqual(recv);
  });

  it('is never in the future (a clock that runs ahead)', () => {
    expect(payloadTime(R + 1, recv)).toEqual(recv);
    expect(payloadTime(R + 86_400_000, recv)).toEqual(recv);
    expect(payloadTime(Number.MAX_VALUE, recv)).toEqual(recv);
  });

  it('is recv when the timestamp is null or not finite', () => {
    expect(payloadTime(null, recv)).toEqual(recv);
    expect(payloadTime(Number.NaN, recv)).toEqual(recv);
    expect(payloadTime(Number.POSITIVE_INFINITY, recv)).toEqual(recv);
    expect(payloadTime(Number.NEGATIVE_INFINITY, recv)).toEqual(recv);
  });

  it('keeps an old clock old (resends keep their original timestamp)', () => {
    expect(payloadTime(1_000_000_000_000, recv)).toEqual(new Date(1_000_000_000_000));
  });

  it('raises a negative timestamp to the epoch, so the Date stays valid', () => {
    expect(payloadTime(-5, recv)).toEqual(new Date(0));
    const d = payloadTime(-1e300, recv);
    expect(d.getTime()).toBe(0);
  });

  it('returns a new Date, not recv itself', () => {
    expect(payloadTime(null, recv)).not.toBe(recv);
    expect(payloadTime(R + 1, recv)).not.toBe(recv);
  });
});

describe('clampEventTime', () => {
  it('keeps a timestamp inside [recv − 15 min, recv]', () => {
    expect(clampEventTime(R - 1000, recv)).toEqual(new Date(R - 1000));
    expect(clampEventTime(R, recv)).toEqual(recv);
    expect(clampEventTime(R - EVENT_CLAMP_MS, recv)).toEqual(new Date(R - EVENT_CLAMP_MS));
  });

  it('clamps future and too-old timestamps', () => {
    expect(clampEventTime(R + 60_000, recv)).toEqual(recv);
    expect(clampEventTime(R - EVENT_CLAMP_MS - 1, recv)).toEqual(new Date(R - EVENT_CLAMP_MS));
    expect(clampEventTime(0, recv)).toEqual(new Date(R - 15 * 60 * 1000));
    expect(clampEventTime(-1e300, recv)).toEqual(new Date(R - EVENT_CLAMP_MS));
    expect(clampEventTime(1e300, recv)).toEqual(recv);
  });

  it('is recv when the timestamp is missing or not finite', () => {
    expect(clampEventTime(null, recv)).toEqual(recv);
    expect(clampEventTime(undefined, recv)).toEqual(recv);
    expect(clampEventTime(Number.NaN, recv)).toEqual(recv);
    expect(clampEventTime(Number.POSITIVE_INFINITY, recv)).toEqual(recv);
  });

  it('dates the diary fixture events at their own timestamps', () => {
    type E = { events: { timestamp: number }[]; timestamp: number };
    const p = fixtureJson<E>('event-diary-repeat');
    const at = new Date(p.timestamp);
    expect(p.events.map((e) => clampEventTime(e.timestamp, at).getTime())).toEqual(
      p.events.map((e) => e.timestamp),
    );
  });
});

describe('floorTo', () => {
  it('floors to the bucket since the epoch', () => {
    expect(floorTo(new Date('2026-09-21T13:47:59.999Z'), XP_BUCKET_MS)).toEqual(
      new Date('2026-09-21T13:45:00.000Z'),
    );
    expect(floorTo(new Date('2026-09-21T13:45:00.000Z'), XP_BUCKET_MS)).toEqual(
      new Date('2026-09-21T13:45:00.000Z'),
    );
    expect(floorTo(new Date('2026-09-21T13:47:31.500Z'), LOCATION_BUCKET_MS)).toEqual(
      new Date('2026-09-21T13:47:00.000Z'),
    );
  });

  it('is exact for any epoch-ms time (no float rounding across a bucket edge)', () => {
    // Compare with integer arithmetic around real timestamps, bucket edges included.
    const base = 1_790_000_000_000;
    for (let i = 0; i < 5000; i++) {
      const ms = base + i * 299_993 + (i % 7) - 3;
      for (const bucket of [XP_BUCKET_MS, LOCATION_BUCKET_MS, 86_400_000]) {
        const expected = BigInt(ms) - (BigInt(ms) % BigInt(bucket));
        expect(BigInt(floorTo(new Date(ms), bucket).getTime())).toBe(expected);
      }
    }
  });

  it('returns a new Date', () => {
    const edge = new Date('2026-09-21T13:45:00.000Z');
    expect(floorTo(edge, XP_BUCKET_MS)).not.toBe(edge);
  });

  it('floors dates before the epoch downwards', () => {
    expect(floorTo(new Date(-1), 60_000)).toEqual(new Date(-60_000));
  });

  it('rejects a non-positive or non-finite bucket', () => {
    expect(() => floorTo(recv, 0)).toThrow(RangeError);
    expect(() => floorTo(recv, -5)).toThrow(RangeError);
    expect(() => floorTo(recv, Number.NaN)).toThrow(RangeError);
    expect(() => floorTo(recv, Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe('utcDay', () => {
  it('is the UTC calendar day', () => {
    expect(utcDay(new Date('2026-09-21T13:40:00Z'))).toBe('2026-09-21');
    expect(utcDay(new Date('2026-09-21T23:59:59.999Z'))).toBe('2026-09-21');
    expect(utcDay(new Date('2026-09-22T00:00:00Z'))).toBe('2026-09-22');
    // 01:30 in UTC+2 is still the previous day in UTC.
    expect(utcDay(new Date('2026-09-22T01:30:00+02:00'))).toBe('2026-09-21');
    expect(utcDay(new Date('2027-01-01T00:00:00Z'))).toBe('2027-01-01');
  });
});

describe('isStaleSnapshot', () => {
  const t = (ms: number) => new Date(R + ms);
  const prev = { sourceDeviceId: 'dev-a', sourceTs: t(0) };

  it('is stale only for the same device with an older payload time', () => {
    expect(isStaleSnapshot(prev, 'dev-a', t(-1))).toBe(true);
    expect(isStaleSnapshot(prev, 'dev-a', t(-60_000))).toBe(true);
  });

  it('is not stale for an equal or newer payload time', () => {
    expect(isStaleSnapshot(prev, 'dev-a', t(0))).toBe(false);
    expect(isStaleSnapshot(prev, 'dev-a', t(1))).toBe(false);
  });

  it('applies snapshots from another device in arrival order', () => {
    expect(isStaleSnapshot(prev, 'dev-b', t(-3_600_000))).toBe(false);
  });

  it('is never stale without a previous snapshot, device or time', () => {
    expect(isStaleSnapshot(null, 'dev-a', t(-1))).toBe(false);
    expect(isStaleSnapshot({ sourceDeviceId: null, sourceTs: t(0) }, 'dev-a', t(-1))).toBe(false);
    expect(isStaleSnapshot({ sourceDeviceId: 'dev-a', sourceTs: null }, 'dev-a', t(-1))).toBe(
      false,
    );
  });

  it('skips the older burst payload that arrives second (same tick, out of order)', () => {
    type P = { timestamp: number };
    const at = (
      name: 'snapshot-combat-burst-1' | 'snapshot-combat-burst-2' | 'snapshot-combat-burst-3',
    ) => payloadTime(fixtureJson<P>(name).timestamp, new Date(fixtureJson<P>(name).timestamp + 40));
    const applied = { sourceDeviceId: 'dev-a', sourceTs: at('snapshot-combat-burst-2') };
    expect(isStaleSnapshot(applied, 'dev-a', at('snapshot-combat-burst-1'))).toBe(true);
    expect(isStaleSnapshot(applied, 'dev-a', at('snapshot-combat-burst-2'))).toBe(false);
    expect(isStaleSnapshot(applied, 'dev-a', at('snapshot-combat-burst-3'))).toBe(false);
  });

  it('flags the resent payload that the overtaking snapshot already replaced', () => {
    type P = { timestamp: number };
    const overtakingTs = fixtureJson<P>('retry-overtaking-snapshot').timestamp;
    const overtaking = payloadTime(overtakingTs, new Date(overtakingTs + 50));
    // The resend arrives ~30 s later but keeps its original, older root timestamp.
    const resend = payloadTime(
      fixtureJson<P>('retry-duplicate-b').timestamp,
      new Date(overtakingTs + 30_000),
    );
    const applied = { sourceDeviceId: 'dev-a', sourceTs: overtaking };
    expect(isStaleSnapshot(applied, 'dev-a', resend)).toBe(true);
    expect(isStaleSnapshot(applied, 'dev-b', resend)).toBe(false);
  });
});

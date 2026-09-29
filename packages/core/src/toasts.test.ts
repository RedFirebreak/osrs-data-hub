import { describe, expect, it } from 'vitest';
import { clampEventTime, EVENT_CLAMP_MS, TOAST_MAX_AGE_MS } from './time';
import { DEFAULT_TOAST_FILTER, shouldToast, type ToastFilter } from './toasts';

const now = new Date('2026-09-28T12:00:00Z');
const ago = (ms: number) => new Date(now.getTime() - ms);
const ctx = { isOwnAccount: false, now };

function ev(type: string, valueGp: number | null = null, occurredAt = ago(30_000)) {
  return { type, valueGp, occurredAt };
}

function filter(over: Partial<ToastFilter> = {}): ToastFilter {
  return { ...DEFAULT_TOAST_FILTER, ...over };
}

describe('DEFAULT_TOAST_FILTER', () => {
  it('shows everything the viewer may see (handoff §11)', () => {
    expect(DEFAULT_TOAST_FILTER).toEqual({
      enabled: true,
      types: null,
      minLootValue: 0,
      ownAccountsOnly: false,
    });
    for (const type of [
      'loot',
      'pk_loot',
      'death',
      'level_up',
      'collection_log',
      'superior_spawn',
      'questComplete',
    ]) {
      expect(shouldToast(ev(type), DEFAULT_TOAST_FILTER, ctx)).toBe(true);
    }
    expect(shouldToast(ev('loot', null), DEFAULT_TOAST_FILTER, ctx)).toBe(true);
    expect(shouldToast(ev('loot', 0), DEFAULT_TOAST_FILTER, ctx)).toBe(true);
  });
});

describe('shouldToast', () => {
  it('is false when disabled', () => {
    expect(
      shouldToast(ev('loot', 1_000_000), filter({ enabled: false }), { isOwnAccount: true, now }),
    ).toBe(false);
  });

  describe('age', () => {
    it('toasts events younger than 15 minutes', () => {
      expect(TOAST_MAX_AGE_MS).toBe(15 * 60 * 1000);
      expect(shouldToast(ev('death', null, ago(0)), filter(), ctx)).toBe(true);
      expect(shouldToast(ev('death', null, ago(10 * 60 * 1000)), filter(), ctx)).toBe(true);
      expect(shouldToast(ev('death', null, ago(TOAST_MAX_AGE_MS - 1)), filter(), ctx)).toBe(true);
    });

    it('skips events 15 minutes old or older (retry-queue stragglers)', () => {
      expect(shouldToast(ev('death', null, ago(TOAST_MAX_AGE_MS)), filter(), ctx)).toBe(false);
      expect(shouldToast(ev('death', null, ago(TOAST_MAX_AGE_MS + 1)), filter(), ctx)).toBe(false);
      expect(shouldToast(ev('death', null, ago(60 * 60 * 1000)), filter(), ctx)).toBe(false);
    });

    it('skips an event whose occurred_at was clamped, even judged at its receive time', () => {
      // occurred_at = clamp(ts, recv − 15 min, recv) (D-17): a clamped event is at least 15 min old,
      // however old it really is, so the result mustn't depend on `now` landing in the same ms as recv.
      expect(EVENT_CLAMP_MS).toBeLessThanOrEqual(TOAST_MAX_AGE_MS);
      const recv = now;
      const hourOld = clampEventTime(recv.getTime() - 60 * 60 * 1000, recv);
      expect(
        shouldToast(ev('loot', 50_000, hourOld), filter(), { isOwnAccount: true, now: recv }),
      ).toBe(false);
      const fresh = clampEventTime(recv.getTime() - 2_000, recv);
      expect(
        shouldToast(ev('loot', 50_000, fresh), filter(), { isOwnAccount: true, now: recv }),
      ).toBe(true);
    });

    it('toasts an event dated after now', () => {
      expect(shouldToast(ev('death', null, ago(-5_000)), filter(), ctx)).toBe(true);
    });

    it('never toasts an invalid date', () => {
      expect(shouldToast(ev('death', null, new Date(Number.NaN)), filter(), ctx)).toBe(false);
      expect(shouldToast(ev('death'), filter(), { ...ctx, now: new Date(Number.NaN) })).toBe(false);
    });
  });

  describe('types', () => {
    it('null allows every type, unknown ones included', () => {
      expect(shouldToast(ev('questComplete'), filter({ types: null }), ctx)).toBe(true);
    });

    it('allows only the listed types', () => {
      const f = filter({ types: ['loot', 'level_up'] });
      expect(shouldToast(ev('loot'), f, ctx)).toBe(true);
      expect(shouldToast(ev('level_up'), f, ctx)).toBe(true);
      expect(shouldToast(ev('death'), f, ctx)).toBe(false);
      expect(shouldToast(ev('pk_loot'), f, ctx)).toBe(false);
    });

    it('matches stored type names exactly', () => {
      const f = filter({ types: ['pk_loot'] });
      expect(shouldToast(ev('pkLoot'), f, ctx)).toBe(false);
      expect(shouldToast(ev('PK_LOOT'), f, ctx)).toBe(false);
    });

    it('an empty list allows nothing', () => {
      expect(shouldToast(ev('loot'), filter({ types: [] }), ctx)).toBe(false);
    });
  });

  describe('minLootValue', () => {
    const f = filter({ minLootValue: 100_000 });

    it('skips loot and pk_loot below the minimum', () => {
      expect(shouldToast(ev('loot', 99_999), f, ctx)).toBe(false);
      expect(shouldToast(ev('pk_loot', 43_188), f, ctx)).toBe(false);
    });

    it('shows loot at or above the minimum', () => {
      expect(shouldToast(ev('loot', 100_000), f, ctx)).toBe(true);
      expect(shouldToast(ev('pk_loot', 38_200_000), f, ctx)).toBe(true);
    });

    it('counts a null value as 0', () => {
      expect(shouldToast(ev('loot', null), f, ctx)).toBe(false);
      expect(shouldToast(ev('loot', null), filter({ minLootValue: 0 }), ctx)).toBe(true);
      expect(shouldToast(ev('pk_loot', null), filter({ minLootValue: 1 }), ctx)).toBe(false);
    });

    it("doesn't apply to other types", () => {
      expect(shouldToast(ev('death', 5), f, ctx)).toBe(true);
      expect(shouldToast(ev('collection_log', 0), f, ctx)).toBe(true);
      expect(shouldToast(ev('level_up', null), f, ctx)).toBe(true);
      expect(shouldToast(ev('pkLoot', 1), f, ctx)).toBe(true);
    });
  });

  describe('ownAccountsOnly', () => {
    it("skips accounts that aren't the viewer's", () => {
      expect(
        shouldToast(ev('loot'), filter({ ownAccountsOnly: true }), { isOwnAccount: false, now }),
      ).toBe(false);
    });

    it("shows the viewer's own accounts", () => {
      expect(
        shouldToast(ev('loot'), filter({ ownAccountsOnly: true }), { isOwnAccount: true, now }),
      ).toBe(true);
    });

    it('is ignored when off', () => {
      expect(
        shouldToast(ev('loot'), filter({ ownAccountsOnly: false }), { isOwnAccount: false, now }),
      ).toBe(true);
    });
  });

  it('needs every check to pass', () => {
    const f = filter({ types: ['loot'], minLootValue: 1_000, ownAccountsOnly: true });
    const own = { isOwnAccount: true, now };
    expect(shouldToast(ev('loot', 5_000), f, own)).toBe(true);
    expect(shouldToast(ev('loot', 500), f, own)).toBe(false);
    expect(shouldToast(ev('loot', 5_000), f, { isOwnAccount: false, now })).toBe(false);
    expect(shouldToast(ev('loot', 5_000, ago(TOAST_MAX_AGE_MS + 1)), f, own)).toBe(false);
    expect(shouldToast(ev('death', 5_000), f, own)).toBe(false);
    expect(shouldToast(ev('loot', 5_000), { ...f, enabled: false }, own)).toBe(false);
  });
});

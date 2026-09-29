import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_TYPES,
  accountTypeLabel,
  formatDuration,
  formatGain,
  formatGp,
  formatNumber,
  relativeTime,
} from './format';

describe('formatGp', () => {
  it('matches the documented examples', () => {
    expect(formatGp(38_200_000)).toBe('38.2M');
    expect(formatGp(1_500)).toBe('1.5K');
    expect(formatGp(999)).toBe('999');
    expect(formatGp(2_147_000_000)).toBe('2.15B');
  });

  it('keeps at most 3 significant digits, rounded, without trailing zeros', () => {
    expect(formatGp(1_000)).toBe('1K');
    expect(formatGp(12_345)).toBe('12.3K');
    expect(formatGp(123_456)).toBe('123K');
    expect(formatGp(34_906)).toBe('34.9K');
    expect(formatGp(43_188)).toBe('43.2K');
    expect(formatGp(35_237_280)).toBe('35.2M');
    expect(formatGp(1_000_000)).toBe('1M');
    expect(formatGp(10_000_000)).toBe('10M');
    expect(formatGp(1_990_000)).toBe('1.99M');
    expect(formatGp(1_995_000)).toBe('2M');
    expect(formatGp(2_147_483_647)).toBe('2.15B');
  });

  it('rolls over to the next unit when rounding reaches 1000', () => {
    expect(formatGp(999_499)).toBe('999K');
    expect(formatGp(999_999)).toBe('1M');
    expect(formatGp(999_500_000)).toBe('1B');
    expect(formatGp(999.6)).toBe('1K');
  });

  it('uses T above billions and keeps counting there', () => {
    expect(formatGp(4_800_000_000_000)).toBe('4.8T');
    expect(formatGp(Number.MAX_SAFE_INTEGER)).toBe('9010T');
  });

  it('rounds small values to integers', () => {
    expect(formatGp(0)).toBe('0');
    expect(formatGp(1)).toBe('1');
    expect(formatGp(12.4)).toBe('12');
    expect(formatGp(0.4)).toBe('0');
    expect(formatGp(-0)).toBe('0');
  });

  it('signs negative values', () => {
    expect(formatGp(-1_500)).toBe('-1.5K');
    expect(formatGp(-12)).toBe('-12');
    expect(formatGp(-0.2)).toBe('0');
  });

  it('shows a dash for missing and non-finite values', () => {
    expect(formatGp(null)).toBe('—');
    expect(formatGp(undefined)).toBe('—');
    expect(formatGp(Number.NaN)).toBe('—');
    expect(formatGp(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

describe('formatNumber', () => {
  it('groups thousands', () => {
    expect(formatNumber(13_034_431)).toBe('13,034,431');
    expect(formatNumber(0)).toBe('0');
    expect(formatNumber(999)).toBe('999');
    expect(formatNumber(1000)).toBe('1,000');
    expect(formatNumber(4_800_000_000)).toBe('4,800,000,000');
    expect(formatNumber(-1234)).toBe('-1,234');
  });

  it('rounds to an integer and never prints "-0"', () => {
    expect(formatNumber(1234.5)).toBe('1,235');
    expect(formatNumber(-0.4)).toBe('0');
    expect(formatNumber(-0)).toBe('0');
  });

  it('shows a dash for missing and non-finite values', () => {
    expect(formatNumber(null)).toBe('—');
    expect(formatNumber(undefined)).toBe('—');
    expect(formatNumber(Number.NaN)).toBe('—');
    expect(formatNumber(Number.NEGATIVE_INFINITY)).toBe('—');
  });
});

describe('formatGain', () => {
  it('signs positive gains with thousands separators', () => {
    expect(formatGain(12_345)).toBe('+12,345');
    expect(formatGain(1)).toBe('+1');
    expect(formatGain(4_800_000_000)).toBe('+4,800,000,000');
  });

  it('is "0" for zero, and never produces a minus sign', () => {
    expect(formatGain(0)).toBe('0');
    expect(formatGain(-0)).toBe('0');
    expect(formatGain(-5)).toBe('0');
    expect(formatGain(0.4)).toBe('0');
    expect(formatGain(Number.NaN)).toBe('0');
    expect(formatGain(Number.POSITIVE_INFINITY)).toBe('0');
  });
});

describe('accountTypeLabel', () => {
  it('labels every IRONMAN varbit value', () => {
    expect(accountTypeLabel(0)).toBe('Normal');
    expect(accountTypeLabel(1)).toBe('Ironman');
    expect(accountTypeLabel(2)).toBe('Ultimate Ironman');
    expect(accountTypeLabel(3)).toBe('Hardcore Ironman');
    expect(accountTypeLabel(4)).toBe('Group Ironman');
    expect(accountTypeLabel(5)).toBe('Hardcore Group Ironman');
    expect(accountTypeLabel(6)).toBe('Unranked Group Ironman');
    expect(Object.keys(ACCOUNT_TYPES)).toHaveLength(7);
  });

  it('is "Unknown" for null and unknown values', () => {
    for (const v of [null, undefined, 7, -1, 1.5, Number.NaN, 127])
      expect(accountTypeLabel(v)).toBe('Unknown');
  });
});

describe('relativeTime', () => {
  const now = new Date('2026-09-21T13:40:00.000Z');
  const ago = (ms: number) => relativeTime(new Date(now.getTime() - ms), now);

  it('says "just now" under a minute, and for the future', () => {
    expect(ago(0)).toBe('just now');
    expect(ago(59_999)).toBe('just now');
    expect(ago(-3_600_000)).toBe('just now');
  });

  it('floors to minutes, hours and days', () => {
    expect(ago(60_000)).toBe('1 min ago');
    expect(ago(3 * 60_000 + 59_000)).toBe('3 min ago');
    expect(ago(59 * 60_000)).toBe('59 min ago');
    expect(ago(60 * 60_000)).toBe('1 h ago');
    expect(ago(119 * 60_000)).toBe('1 h ago');
    expect(ago(2 * 3_600_000)).toBe('2 h ago');
    expect(ago(24 * 3_600_000 - 1)).toBe('23 h ago');
    expect(ago(24 * 3_600_000)).toBe('1 d ago');
    expect(ago(5 * 86_400_000 + 1000)).toBe('5 d ago');
    expect(ago(400 * 86_400_000)).toBe('400 d ago');
  });

  it('treats invalid dates as "just now"', () => {
    expect(relativeTime(new Date(Number.NaN), now)).toBe('just now');
    expect(relativeTime(now, new Date(Number.NaN))).toBe('just now');
  });
});

describe('formatDuration', () => {
  it('matches the documented examples', () => {
    expect(formatDuration(5400)).toBe('1h 30m');
    expect(formatDuration(45)).toBe('45s');
    expect(formatDuration(3600 * 30)).toBe('30h 0m');
  });

  it('shows the two largest units, hours never rolled into days', () => {
    expect(formatDuration(90)).toBe('1m 30s');
    expect(formatDuration(60)).toBe('1m 0s');
    expect(formatDuration(3599)).toBe('59m 59s');
    expect(formatDuration(3600)).toBe('1h 0m');
    expect(formatDuration(3661)).toBe('1h 1m');
    expect(formatDuration(1_000 * 3600 + 59)).toBe('1000h 0m');
  });

  it('floors fractions; zero, negative and non-finite values are "0s"', () => {
    expect(formatDuration(59.9)).toBe('59s');
    expect(formatDuration(0.5)).toBe('0s');
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(-10)).toBe('0s');
    expect(formatDuration(Number.NaN)).toBe('0s');
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe('0s');
  });
});

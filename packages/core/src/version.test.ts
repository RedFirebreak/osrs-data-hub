import { describe, expect, it } from 'vitest';
import { compareVersions, formatVersion, meetsMinimumVersion, parsePluginVersion } from './version';

describe('parsePluginVersion', () => {
  it.each([
    ['1.5', [1, 5, 0]],
    ['1.5.1', [1, 5, 1]],
    ['1.6-SNAPSHOT', [1, 6, 0]],
    [' 1.5 ', [1, 5, 0]],
    ['\t1.5\n', [1, 5, 0]],
    ['2', [2, 0, 0]],
    ['1.', [1, 0, 0]],
    ['1..5', [1, 0, 0]],
    ['1.5.1.9', [1, 5, 1]],
    ['1.5.1-rc.2', [1, 5, 1]],
    ['1.5a', [1, 5, 0]],
    ['01.05.00', [1, 5, 0]],
    ['0.0.0', [0, 0, 0]],
    ['1000000.1000000.1000000', [1_000_000, 1_000_000, 1_000_000]],
  ])('%j → %j', (header, expected) => {
    expect(parsePluginVersion(header)).toEqual(expected);
  });

  it.each([null, undefined, '', '   ', 'abc', 'v1.5', '-1.5', '+1.5', '.5', 'SNAPSHOT-1.5'])(
    'rejects %j',
    (header) => {
      expect(parsePluginVersion(header)).toBeNull();
    },
  );

  it('rejects components above 1e6', () => {
    expect(parsePluginVersion('1000001')).toBeNull();
    expect(parsePluginVersion('1.1000001')).toBeNull();
    expect(parsePluginVersion('1.5.1000001')).toBeNull();
    expect(parsePluginVersion('99999999999999999999999.5')).toBeNull();
  });

  it('only accepts ASCII digits', () => {
    // U+0663 ARABIC-INDIC DIGIT THREE: Java's Character.isDigit accepts it, the version gate must not.
    expect(parsePluginVersion(`${String.fromCharCode(0x663)}.5`)).toBeNull();
  });
});

describe('compareVersions', () => {
  it('orders component by component', () => {
    expect(compareVersions([1, 5, 0], [1, 5, 0])).toBe(0);
    expect(compareVersions([1, 5, 0], [1, 5, 1])).toBe(-1);
    expect(compareVersions([1, 5, 1], [1, 5, 0])).toBe(1);
    expect(compareVersions([1, 4, 99], [1, 5, 0])).toBe(-1);
    expect(compareVersions([2, 0, 0], [1, 99, 99])).toBe(1);
    expect(compareVersions([0, 0, 1], [0, 0, 0])).toBe(1);
  });

  it('compares numerically, not as strings', () => {
    expect(compareVersions([1, 10, 0], [1, 9, 0])).toBe(1);
  });
});

describe('meetsMinimumVersion', () => {
  it('accepts equal and newer versions', () => {
    expect(meetsMinimumVersion('1.5', '1.5')).toBe(true);
    expect(meetsMinimumVersion('1.5.0', '1.5')).toBe(true);
    expect(meetsMinimumVersion('1.5.1', '1.5')).toBe(true);
    expect(meetsMinimumVersion('1.6-SNAPSHOT', '1.5')).toBe(true);
    expect(meetsMinimumVersion('1.10', '1.9')).toBe(true);
    expect(meetsMinimumVersion('2.0', '1.5.3')).toBe(true);
  });

  it('refuses older, missing and unparsable versions', () => {
    expect(meetsMinimumVersion('1.4', '1.5')).toBe(false);
    expect(meetsMinimumVersion('1.4.99', '1.5')).toBe(false);
    expect(meetsMinimumVersion('1.5', '1.5.1')).toBe(false);
    expect(meetsMinimumVersion(null, '1.5')).toBe(false);
    expect(meetsMinimumVersion(undefined, '1.5')).toBe(false);
    expect(meetsMinimumVersion('', '1.5')).toBe(false);
    expect(meetsMinimumVersion('v1.5', '1.5')).toBe(false);
  });

  it('throws on an unparsable minimum (a configuration error)', () => {
    expect(() => meetsMinimumVersion('1.5', 'latest')).toThrow(/invalid minimum plugin version/);
  });
});

describe('formatVersion', () => {
  it('always prints three components', () => {
    expect(formatVersion([1, 5, 0])).toBe('1.5.0');
    expect(formatVersion([10, 0, 3])).toBe('10.0.3');
  });

  it('round-trips through parsePluginVersion', () => {
    const v = parsePluginVersion('1.6-SNAPSHOT');
    expect(v).not.toBeNull();
    if (v) expect(parsePluginVersion(formatVersion(v))).toEqual(v);
  });
});

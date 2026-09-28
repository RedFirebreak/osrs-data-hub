import { describe, expect, it } from 'vitest';
import { stripNul } from './json';

describe('stripNul', () => {
  it('removes NUL from strings at any depth', () => {
    const input = {
      a: 'x\u0000y',
      b: ['\u0000', 'ok', { c: '\u0000\u0000z\u0000' }],
      d: { e: { f: 'no nul' } },
    };
    expect(stripNul(input)).toEqual({
      a: 'xy',
      b: ['', 'ok', { c: 'z' }],
      d: { e: { f: 'no nul' } },
    });
  });

  it('removes NUL from object keys', () => {
    expect(stripNul({ 'ke\u0000y': 1, nested: { '\u0000k': 'v' } })).toEqual({
      key: 1,
      nested: { k: 'v' },
    });
  });

  it('replaces lone surrogates with U+FFFD in strings and keys (jsonb rejects them)', () => {
    const hi = String.fromCharCode(0xd800);
    const lo = String.fromCharCode(0xdfff);
    expect(stripNul(`a${hi}b`)).toBe('a\uFFFDb');
    expect(stripNul(`${lo}x`)).toBe('\uFFFDx');
    expect(stripNul(`x${hi}`)).toBe('x\uFFFD');
    // A low half before a high half is two lone surrogates, not a pair.
    expect(stripNul(`${lo}${hi}`)).toBe('\uFFFD\uFFFD');
    expect(stripNul(`${hi}${hi}${lo}`)).toBe(`\uFFFD${hi}${lo}`);
    expect(stripNul({ [`k${lo}`]: [`v${hi}`] })).toEqual({ 'k\uFFFD': ['v\uFFFD'] });
  });

  it('keeps valid surrogate pairs', () => {
    expect(stripNul('Ze\u{1F600}zima')).toBe('Ze\u{1F600}zima');
    expect(stripNul({ '\u{1F600}': '\u{1F9D9}' })).toEqual({ '\u{1F600}': '\u{1F9D9}' });
  });

  it('removes NUL before checking surrogates, so halves around a NUL form a pair', () => {
    const [hi, lo] = ['\u{1F600}'.charAt(0), '\u{1F600}'.charAt(1)];
    expect(stripNul(`${hi}\u0000${lo}`)).toBe('\u{1F600}');
  });

  it('keeps other control characters', () => {
    expect(stripNul('a\u0001\u001f\n\tb')).toBe('a\u0001\u001f\n\tb');
  });

  it('copies other values as-is', () => {
    expect(stripNul(42)).toBe(42);
    expect(stripNul(2.0e-4)).toBe(2.0e-4);
    expect(stripNul(true)).toBe(true);
    expect(stripNul(null)).toBeNull();
    expect(stripNul(undefined)).toBeUndefined();
    const date = new Date(0);
    expect(stripNul({ date }).date).toBe(date);
    expect(stripNul([1, null, false])).toEqual([1, null, false]);
  });

  it('returns a deep copy and leaves the input untouched', () => {
    const input = { a: { b: ['x\u0000'] }, c: [{ d: 1 }] };
    const out = stripNul(input);
    expect(out).not.toBe(input);
    expect(out.a).not.toBe(input.a);
    expect(out.a.b).not.toBe(input.a.b);
    expect(out.c[0]).not.toBe(input.c[0]);
    expect(input.a.b[0]).toBe('x\u0000');
  });

  it('keeps a "__proto__" key as data instead of setting the prototype', () => {
    const input = JSON.parse('{"__proto__":{"polluted":"\\u0000yes"},"ok":1}') as Record<
      string,
      unknown
    >;
    const out = stripNul(input);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(Object.hasOwn(out, '__proto__')).toBe(true);
    expect((out as { polluted?: unknown }).polluted).toBeUndefined();
    expect(JSON.stringify(out)).toBe('{"__proto__":{"polluted":"yes"},"ok":1}');
  });

  it('lets the later key win when keys only differ by NUL or a lone surrogate', () => {
    expect(stripNul({ a: 1, 'a\u0000': 2 })).toEqual({ a: 2 });
    const [hi, lo] = [String.fromCharCode(0xd800), String.fromCharCode(0xdc00)];
    expect(stripNul({ [`b${hi}`]: 1, [`b${lo}`]: 2 })).toEqual({ 'b\uFFFD': 2 });
  });

  it('makes a Gson-escaped body jsonb-safe', () => {
    const parsed: unknown = JSON.parse(
      '{"events":[{"type":"loot","data":{"source":{"text":"Bad\\u0000Name\\ud800"}}}]}',
    );
    const json = JSON.stringify(stripNul(parsed));
    expect(json).not.toContain('\\u0000');
    expect(json).not.toMatch(/\\ud[89a-f]/i);
    expect(json).toContain('BadName\uFFFD');
  });
});

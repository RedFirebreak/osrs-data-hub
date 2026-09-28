import { describe, expect, it } from 'vitest';
import { stripNul } from './json';

describe('stripNul', () => {
  it('removes NUL from strings at any depth', () => {
    const input = {
      a: 'x\u0000y',
      b: ['\u0000', 'ok', { c: '\u0000\u0000z\u0000' }],
      d: { e: { f: 'no nul' } },
    };
    expect(stripNul(input)).toEqual({ a: 'xy', b: ['', 'ok', { c: 'z' }], d: { e: { f: 'no nul' } } });
  });

  it('removes NUL from object keys', () => {
    expect(stripNul({ 'ke\u0000y': 1, nested: { '\u0000k': 'v' } })).toEqual({ key: 1, nested: { k: 'v' } });
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
    const input = JSON.parse('{"__proto__":{"polluted":"\\u0000yes"},"ok":1}') as Record<string, unknown>;
    const out = stripNul(input);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(Object.hasOwn(out, '__proto__')).toBe(true);
    expect((out as { polluted?: unknown }).polluted).toBeUndefined();
    expect(JSON.stringify(out)).toBe('{"__proto__":{"polluted":"yes"},"ok":1}');
  });

  it('lets the later key win when keys only differ by NUL', () => {
    expect(stripNul({ a: 1, 'a\u0000': 2 })).toEqual({ a: 2 });
  });

  it('produces JSON without \\u0000 for a Gson-escaped body', () => {
    const parsed: unknown = JSON.parse('{"events":[{"type":"loot","data":{"source":{"text":"Bad\\u0000Name"}}}]}');
    expect(JSON.stringify(stripNul(parsed))).not.toContain('\\u0000');
    expect(JSON.stringify(stripNul(parsed))).toContain('BadName');
  });
});

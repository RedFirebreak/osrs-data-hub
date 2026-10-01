import { describe, expect, it } from 'vitest';
import { isPlainObject, isRecord } from './guards';

describe('object guards', () => {
  it('both accept plain objects and reject null, arrays and primitives', () => {
    for (const guard of [isRecord, isPlainObject]) {
      expect(guard({})).toBe(true);
      expect(guard({ a: 1 })).toBe(true);
      expect(guard(Object.create(null))).toBe(true);
      expect(guard(JSON.parse('{"__proto__": 1}'))).toBe(true);
      expect(guard(null)).toBe(false);
      expect(guard(undefined)).toBe(false);
      expect(guard([])).toBe(false);
      expect(guard([{}])).toBe(false);
      expect(guard('text')).toBe(false);
      expect(guard(1)).toBe(false);
      expect(guard(() => 1)).toBe(false);
    }
  });

  it('differ on objects that are not plain', () => {
    class Point {
      x = 1;
    }
    for (const value of [new Date(0), new Map(), new Point()]) {
      expect(isRecord(value)).toBe(true);
      expect(isPlainObject(value)).toBe(false);
    }
  });
});

import { isPlainObject } from './guards';

/**
 * Deep copy that makes every string and object key storable in Postgres: U+0000 is removed (text and
 * jsonb reject it, and Gson emits "\u0000" for control characters; DB-1), then every lone UTF-16
 * surrogate is replaced by U+FFFD (jsonb rejects an unpaired "\ud800" escape, which JSON.stringify
 * writes for one). Arrays and plain objects are copied; other values (numbers, booleans, null, and
 * non-plain objects such as Date) are returned as-is. When two keys only differ by those characters,
 * the later one wins.
 */
export function stripNul<T>(value: T): T {
  return strip(value) as T;
}

/** A high surrogate not followed by a low one, or a low surrogate not preceded by a high one. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

function clean(s: string): string {
  return s.replaceAll('\u0000', '').replace(LONE_SURROGATE, '\uFFFD');
}

function strip(value: unknown): unknown {
  if (typeof value === 'string') return clean(value);
  if (Array.isArray(value)) return value.map(strip);
  if (isPlainObject(value)) {
    // fromEntries defines own properties, so a "__proto__" key stays data instead of a prototype.
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [clean(k), strip(v)]));
  }
  return value;
}

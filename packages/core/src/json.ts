/**
 * Deep copy with U+0000 removed from every string and object key: Postgres jsonb rejects "\u0000",
 * which Gson emits for control characters (DB-1). Arrays and plain objects are copied; other values
 * (numbers, booleans, null, and non-plain objects such as Date) are returned as-is. When two keys only
 * differ by NUL characters, the later one wins.
 */
export function stripNul<T>(value: T): T {
  return strip(value) as T;
}

function strip(value: unknown): unknown {
  if (typeof value === 'string') return value.includes('\u0000') ? value.replaceAll('\u0000', '') : value;
  if (Array.isArray(value)) return value.map(strip);
  if (isPlainObject(value)) {
    // fromEntries defines own properties, so a "__proto__" key stays data instead of a prototype.
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k.replaceAll('\u0000', ''), strip(v)]),
    );
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

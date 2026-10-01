/**
 * The two object guards core uses on untrusted values. They differ on purpose, so pick by what the
 * caller does with the value:
 * - isRecord: something to read keys from. Any non-null object that isn't an array (a Date or a class
 *   instance passes; reading a key it doesn't have gives undefined).
 * - isPlainObject: something safe to copy or walk key by key. Only objects made by `{}`, JSON.parse or
 *   Object.create(null); a Date, a Map or a class instance fails, and so does an array.
 * On JSON.parse output the two agree.
 */

/** A non-null object that isn't an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** An object whose prototype is Object.prototype or null. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

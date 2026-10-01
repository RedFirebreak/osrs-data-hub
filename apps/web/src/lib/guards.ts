/**
 * Small guards for values that arrive as plain strings (URL parameters, ids in JSON bodies). No
 * React, no browser APIs. The object guards (isRecord, isPlainObject) are @hub/core's.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether `value` has the shape of a uuid (any version, either case). */
export function isUuidLike(value: string): boolean {
  return UUID_RE.test(value);
}

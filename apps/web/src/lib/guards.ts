/**
 * Small type guards for values that arrive as `unknown` (JSON bodies, live messages, URL parameters).
 * No React, no browser APIs.
 */

/** A plain object (not null, not an array). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether `value` has the shape of a uuid (any version, either case). */
export function isUuidLike(value: string): boolean {
  return UUID_RE.test(value);
}

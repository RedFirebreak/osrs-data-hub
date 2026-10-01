/**
 * Small type guards for values that arrive as `unknown` (JSON bodies, live messages, URL parameters).
 * No React, no browser APIs.
 */

/** A plain object (not null, not an array). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

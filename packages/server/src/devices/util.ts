/** Longest label kept for a device or pairing code (the plugin caps its connection names at 64 too). */
export const DEVICE_LABEL_MAX = 64;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A user-supplied device label as stored: control characters become spaces, the result is trimmed and
 * cut to DEVICE_LABEL_MAX code points (never in the middle of a surrogate pair, which would store a
 * U+FFFD), and an empty label becomes null ("no label").
 */
export function normalizeDeviceLabel(label: string | null | undefined): string | null {
  if (typeof label !== 'string') return null;
  const cleaned = label.replace(/\p{Cc}/gu, ' ').trim();
  const cut = Array.from(cleaned).slice(0, DEVICE_LABEL_MAX).join('').trimEnd();
  return cut === '' ? null : cut;
}

/**
 * True for a canonical uuid string. Ids from URLs are checked before they reach a uuid column:
 * Postgres answers a malformed uuid with 22P02 instead of "no row".
 */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** Longest label kept for a device or pairing code (the plugin caps its connection names at 64 too). */
export const DEVICE_LABEL_MAX = 64;

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

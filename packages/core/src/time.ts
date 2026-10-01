/** Milliseconds per minute, hour and day: the one definition the packages and the web app share. */
export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

export const XP_BUCKET_MS = 5 * 60 * 1000;
export const LOCATION_BUCKET_MS = 60 * 1000;
/** Events are clamped to [recv − 15 min, recv]: the plugin queue holds events ≤ 10 min, plus margin. */
export const EVENT_CLAMP_MS = 15 * 60 * 1000;
/** Toasts are skipped for events older than this (they still reach the feed). */
export const TOAST_MAX_AGE_MS = 15 * 60 * 1000;
/** Live location is considered stale after this long without an update. */
export const LOCATION_STALE_MS = 2 * 60 * 1000;

/**
 * payload_ts = min(root.timestamp, recv); recv when the root timestamp is null/non-finite. Never in the
 * future. A negative timestamp (a clock before 1970) is raised to the epoch, so the result is always a
 * valid Date and a valid Postgres timestamptz.
 */
export function payloadTime(rootTimestamp: number | null, recv: Date): Date {
  const recvMs = recv.getTime();
  if (rootTimestamp === null || !Number.isFinite(rootTimestamp)) return new Date(recvMs);
  return new Date(Math.min(Math.max(rootTimestamp, 0), recvMs));
}

/** occurred_at = clamp(ts, recv − 15 min, recv); recv when ts is null/non-finite. */
export function clampEventTime(ts: number | null | undefined, recv: Date): Date {
  const recvMs = recv.getTime();
  if (ts === null || ts === undefined || !Number.isFinite(ts)) return new Date(recvMs);
  return new Date(Math.min(Math.max(ts, recvMs - EVENT_CLAMP_MS), recvMs));
}

/** Floors to a multiple of `bucketMs` since the epoch (UTC). Throws on a non-positive bucket. */
export function floorTo(date: Date, bucketMs: number): Date {
  if (!Number.isFinite(bucketMs) || bucketMs <= 0) {
    throw new RangeError(`invalid bucket: ${bucketMs}`);
  }
  return new Date(Math.floor(date.getTime() / bucketMs) * bucketMs);
}

/** UTC calendar day "YYYY-MM-DD". */
export function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Stale when the last applied snapshot came from THIS device and this payload is older than it.
 * Snapshots from another device are applied in arrival order (clocks differ between PCs). (D-17)
 */
export function isStaleSnapshot(
  prev: { sourceDeviceId: string | null; sourceTs: Date | null } | null,
  deviceId: string,
  payloadTs: Date,
): boolean {
  if (prev === null || prev.sourceDeviceId !== deviceId || prev.sourceTs === null) return false;
  return payloadTs.getTime() < prev.sourceTs.getTime();
}

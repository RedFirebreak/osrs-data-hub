import {
  KNOWN_EVENT_TYPES,
  TokenBucketLimiter,
  formatVersion,
  parsePluginVersion,
  type Clock,
} from '@hub/core';
import type { HubMetrics } from '../metrics';

/** Per-device bucket (handoff §7.6): bursts up to 30, 5 per second sustained. */
export const INGEST_BUCKET_CAPACITY = 30;
export const INGEST_REFILL_PER_SECOND = 5;
/**
 * Shortest pause asked of a rate-limited device (handoff §7.6, ARCHITECTURE §6: "429 + Retry-After:
 * 3"). At 5/s the bucket has a token back after 0.2 s, which would say 1; the plugin drops snapshots
 * while paused, so a 3 s pause is what actually relieves a noisy device.
 */
export const INGEST_MIN_RETRY_AFTER_SECONDS = 3;

/**
 * Events handled per payload. The plugin sends a handful; the rest of a larger list is counted as
 * skipped, which bounds the rows (a levelUp alone can become 64) one request can insert.
 */
export const MAX_EVENTS_PER_PAYLOAD = 200;

/** plugin_version is stored truncated to this many characters. */
export const MAX_VERSION_TEXT = 32;

/**
 * The per-device token bucket for snapshot-only payloads. One instance per process; the host keeps
 * it on globalThis (D-37). `clock` is for tests.
 */
export function createIngestLimiter(opts: { clock?: Clock } = {}): TokenBucketLimiter {
  return new TokenBucketLimiter({
    capacity: INGEST_BUCKET_CAPACITY,
    refillPerSecond: INGEST_REFILL_PER_SECOND,
    clock: opts.clock,
  });
}

/** Distinct plugin-version labels per metrics registry; later versions count as 'other'. */
const MAX_VERSION_LABELS = 32;
const KNOWN_TYPES: ReadonlySet<string> = new Set(KNOWN_EVENT_TYPES);
const g = globalThis as unknown as { __hubIngestVersionLabels?: WeakMap<object, Set<string>> };

/**
 * Label for metrics.pluginVersions: 'none' (missing/blank header), 'invalid' (doesn't parse), else
 * the normalized version ("1.5" → "1.5.0"). The header is client-controlled and counted before
 * authentication, so the number of distinct labels is capped (then 'other') to keep /metrics bounded.
 */
export function versionLabel(metrics: HubMetrics, header: string | null): string {
  if (header === null || header.trim() === '') return 'none';
  const version = parsePluginVersion(header);
  if (version === null) return 'invalid';
  const label = formatVersion(version);
  g.__hubIngestVersionLabels ??= new WeakMap();
  let seen = g.__hubIngestVersionLabels.get(metrics);
  if (!seen) {
    seen = new Set();
    g.__hubIngestVersionLabels.set(metrics, seen);
  }
  if (seen.has(label)) return label;
  if (seen.size >= MAX_VERSION_LABELS) return 'other';
  seen.add(label);
  return label;
}

/** Label for metrics.ingestEvents: known types as stored, anything else 'other' (bounded). */
export function eventTypeLabel(type: string): string {
  return KNOWN_TYPES.has(type) ? type : 'other';
}

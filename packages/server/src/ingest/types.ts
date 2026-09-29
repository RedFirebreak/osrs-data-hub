import type { TokenBucketLimiter } from '@hub/core';
import type { Db } from '@hub/db';
import type { Logger } from '../logger';
import type { HubMetrics } from '../metrics';

/** What `handleIngest` needs from its host (the web route handler, or a test). */
export interface IngestDeps {
  db: Db;
  /** MIN_PLUGIN_VERSION, e.g. '1.5'. */
  minPluginVersion: string;
  /** INGEST_MAX_BODY_KB * 1024. */
  maxBodyBytes: number;
  /** Per-device token bucket; see createIngestLimiter(). */
  limiter: TokenBucketLimiter;
  logger: Logger;
  metrics: HubMetrics;
  /** The admin decommission switch: true → 410 for every request. */
  isDecommissioned: () => boolean | Promise<boolean>;
  /** Clock override (tests). */
  now?: () => Date;
}

/** The parts of the HTTP request that ingest reads. */
export interface IngestRequest {
  /** X-Osrs-Token. */
  token: string | null;
  /** X-Osrs-Exporter-Version. */
  versionHeader: string | null;
  /** Client IP (see clientIpFromHeaders), null when unknown. */
  ip: string | null;
  /** Reads the body (UTF-8) with a hard cap; resolves null when it exceeds maxBytes. */
  readBody: (maxBytes: number) => Promise<string | null>;
}

/** Why an accepted payload stored nothing (raw_payloads.meta.ignored, metrics.ingestIgnored). */
export type IgnoredReason = 'no_identity' | 'blocked';

/**
 * raw_payloads.meta: what happened to an archived payload. Ids, counts and codes only; never
 * coordinates, tokens or DB error messages.
 */
export interface IngestMeta {
  /** Paths of player sections dropped by lenient parsing. */
  skippedSections?: string[];
  /** Why sections/events were dropped (parser messages, which never echo values). */
  skippedReasons?: string[];
  /** Malformed events, levelUp elements, and events beyond the per-payload cap. */
  skippedEvents?: number;
  /** Event rows stored. */
  inserted?: number;
  /** Event rows that were already stored (plugin resends). */
  duplicates?: number;
  /** The snapshot was older than this device's last applied one (D-17). */
  stale?: boolean;
  /** The payload came from a special world (live fields only). */
  special?: boolean;
  /** Skill whose XP dropped on a normal world (D-24): the snapshot was treated as special. */
  xpGuard?: string;
  ignored?: IgnoredReason;
  /** Play sessions closed by a clientShutdown in a payload without identity (D-29). */
  closedSessions?: number;
  /** The `error` of a non-200 response, or the parser's not_json/not_object. */
  error?: string;
  /** SQLSTATE of the database error behind a 4xx/5xx, when there was one. */
  pgCode?: string;
  /** Processing time in ms. */
  ms?: number;
}

/**
 * Prometheus metrics (handoff §16). The registry lives on globalThis: Next.js route handlers and
 * RSC/server code are separate module instances and would otherwise register twice (NEXT-3).
 *
 * Web and worker create the same set and each serves its own (D-84): a series only moves in the
 * process that does the work, so dashboards sum over both. Every label value comes from a fixed set
 * in our own code, never an id, name, address or coordinate (D-53).
 */
import { constantTimeEqual } from '@hub/core';
import { OFFBOARD_REASONS } from '@hub/db';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/** The worker's pg-boss jobs: the `job_name` label of the hub_job_* metrics. */
export const JOB_NAMES = [
  'close-stale-sessions',
  'reverify-members',
  'expire-grace',
  'prune-audit-log',
] as const;
export type JobName = (typeof JOB_NAMES)[number];

/** Route groups of the public API: the `group` label of the hub_api_* metrics. */
export const API_ROUTE_GROUPS = [
  'me',
  'accounts',
  'events',
  'snapshot',
  'xp',
  'leaderboards',
  'openapi',
  'unknown',
] as const;
export type ApiRouteGroup = (typeof API_ROUTE_GROUPS)[number];

function create() {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry, prefix: 'hub_' });
  const m = {
    registry,
    ingestPayloads: new Counter({
      name: 'hub_ingest_payloads_total',
      help: 'Ingest requests by HTTP status returned',
      labelNames: ['status'] as const,
      registers: [registry],
    }),
    ingestEvents: new Counter({
      name: 'hub_ingest_events_total',
      help: 'Events stored, by type',
      labelNames: ['type'] as const,
      registers: [registry],
    }),
    ingestDuplicates: new Counter({
      name: 'hub_ingest_duplicate_events_total',
      help: 'Events already stored (plugin resends)',
      registers: [registry],
    }),
    ingestSkippedSections: new Counter({
      name: 'hub_ingest_skipped_sections_total',
      help: 'Payload sections dropped by lenient parsing',
      registers: [registry],
    }),
    ingestSkippedEvents: new Counter({
      name: 'hub_ingest_skipped_events_total',
      help: 'Malformed events dropped',
      registers: [registry],
    }),
    ingestIgnored: new Counter({
      name: 'hub_ingest_ignored_total',
      help: 'Payloads accepted but ignored, by reason',
      labelNames: ['reason'] as const,
      registers: [registry],
    }),
    ingestLatency: new Histogram({
      name: 'hub_ingest_duration_seconds',
      help: 'Ingest request processing time',
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [registry],
    }),
    pluginVersions: new Counter({
      name: 'hub_plugin_requests_by_version_total',
      help: 'Plugin requests by X-Osrs-Exporter-Version',
      labelNames: ['version'] as const,
      registers: [registry],
    }),
    pairAttempts: new Counter({
      name: 'hub_pair_attempts_total',
      help: 'Pairing attempts by result',
      labelNames: ['result'] as const,
      registers: [registry],
    }),
    sseConnections: new Gauge({
      name: 'hub_sse_connections',
      help: 'Open live (SSE) connections',
      registers: [registry],
    }),
    discordVerifyFailures: new Counter({
      name: 'hub_discord_verify_failures_total',
      help: 'Discord membership checks that failed (errors, not "not a member")',
      labelNames: ['kind'] as const,
      registers: [registry],
    }),
    discordVerifyChecks: new Counter({
      name: 'hub_discord_verify_checks_total',
      help: 'Discord membership re-verifications by verdict (member, not_member, missing_role, error)',
      labelNames: ['verdict'] as const,
      registers: [registry],
    }),
    discordVerifyBreakerTrips: new Counter({
      name: 'hub_discord_verify_breaker_trips_total',
      help: 'Re-verification runs a circuit breaker stopped (nobody offboarded), by rule',
      labelNames: ['rule'] as const,
      registers: [registry],
    }),
    offboardedUsers: new Counter({
      name: 'hub_offboarded_users_total',
      help: 'Active users moved into grace, by reason (self_delete: Delete my data)',
      labelNames: ['reason'] as const,
      registers: [registry],
    }),
    graceExpiredUsers: new Counter({
      name: 'hub_grace_expired_users_total',
      help: 'Users deleted when their grace period ended',
      registers: [registry],
    }),
    accountsDeleted: new Counter({
      name: 'hub_accounts_deleted_total',
      help: 'OSRS accounts deleted with their data, by cause (grace_expiry, orphan_purge)',
      labelNames: ['cause'] as const,
      registers: [registry],
    }),
    dataExports: new Counter({
      name: 'hub_data_exports_total',
      help: 'Download my data requests by result (completed, failed, cancelled, rate_limited)',
      labelNames: ['result'] as const,
      registers: [registry],
    }),
    liveStreamsRefused: new Counter({
      name: 'hub_live_streams_refused_total',
      help: 'Live (SSE) streams refused by the per-user limit (D-80)',
      registers: [registry],
    }),
    playSessionsOpen: new Gauge({
      name: 'hub_play_sessions_open',
      help: 'Open play sessions (players online), as of the last close-stale-sessions run',
      registers: [registry],
    }),
    playSessionsTimedOut: new Counter({
      name: 'hub_play_sessions_timed_out_total',
      help: 'Play sessions ended by the presence timeout (no clean logout)',
      registers: [registry],
    }),
    apiRequests: new Counter({
      name: 'hub_api_requests_total',
      help: 'Public API (/api/v1) requests by route group and HTTP status',
      labelNames: ['group', 'status'] as const,
      registers: [registry],
    }),
    apiLatency: new Histogram({
      name: 'hub_api_request_duration_seconds',
      help: 'Public API (/api/v1) request processing time by route group',
      labelNames: ['group'] as const,
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [registry],
    }),
    apiRateLimited: new Counter({
      name: 'hub_api_rate_limited_total',
      help: 'Public API 429s by limit (key, snapshot, auth_ip)',
      labelNames: ['limit'] as const,
      registers: [registry],
    }),
    apiAuthFailures: new Counter({
      name: 'hub_api_auth_failures_total',
      help: 'Public API requests refused 401, by why the key failed',
      labelNames: ['reason'] as const,
      registers: [registry],
    }),
    jobDuration: new Histogram({
      name: 'hub_job_duration_seconds',
      help: 'Worker job run time by job',
      labelNames: ['job_name'] as const,
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300],
      registers: [registry],
    }),
    jobRuns: new Counter({
      name: 'hub_job_runs_total',
      help: 'Worker job runs by job and result (success, failure)',
      labelNames: ['job_name', 'result'] as const,
      registers: [registry],
    }),
    jobLastSuccess: new Gauge({
      name: 'hub_job_last_success_timestamp_seconds',
      help: 'Unix time the job last succeeded (absent until it has, since the worker started)',
      labelNames: ['job_name'] as const,
      registers: [registry],
    }),
  };
  initSeries(m);
  return m;
}

/**
 * Creates every series of a fixed label set at 0. prom-client creates a labelled series on its first
 * inc(), already at 1, and increase() over a series that appears at 1 is 0: the first breaker trip or
 * job failure after a restart would never alert (PROM-1).
 */
function initSeries(m: HubMetrics): void {
  for (const job_name of JOB_NAMES) {
    for (const result of ['success', 'failure']) m.jobRuns.inc({ job_name, result }, 0);
    m.jobDuration.zero({ job_name });
  }
  for (const rule of ['batch', 'window']) m.discordVerifyBreakerTrips.inc({ rule }, 0);
  for (const verdict of ['member', 'not_member', 'missing_role', 'error']) {
    m.discordVerifyChecks.inc({ verdict }, 0);
  }
  for (const kind of ['config', 'auth', 'rate_limited', 'unavailable']) {
    m.discordVerifyFailures.inc({ kind }, 0);
  }
  for (const reason of OFFBOARD_REASONS) m.offboardedUsers.inc({ reason }, 0);
  for (const cause of ['grace_expiry', 'orphan_purge']) m.accountsDeleted.inc({ cause }, 0);
  for (const result of ['completed', 'failed', 'cancelled', 'rate_limited']) {
    m.dataExports.inc({ result }, 0);
  }
  for (const limit of ['key', 'snapshot', 'auth_ip']) m.apiRateLimited.inc({ limit }, 0);
}

export type HubMetrics = ReturnType<typeof create>;

const g = globalThis as unknown as { __hubMetrics?: HubMetrics };

export function getMetrics(): HubMetrics {
  g.__hubMetrics ??= create();
  return g.__hubMetrics;
}

/** Fresh, unshared metrics (tests). */
export function createTestMetrics(): HubMetrics {
  return create();
}

/**
 * Who may read /metrics (D-14, D-84), for the web route and the worker's endpoint alike: 'disabled'
 * without METRICS_TOKEN (answer 404), 'ok' for `Authorization: Bearer <token>` (scheme in any case,
 * token compared in constant time), 'unauthorized' otherwise (401).
 */
export function metricsAccess(
  authorization: string | null | undefined,
  token: string | undefined,
): 'disabled' | 'unauthorized' | 'ok' {
  if (!token) return 'disabled';
  const presented = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(authorization ?? '');
  return presented?.[1] && constantTimeEqual(presented[1], token) ? 'ok' : 'unauthorized';
}

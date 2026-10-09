/**
 * Prometheus metrics (handoff §16). The registry lives on globalThis: Next.js route handlers and
 * RSC/server code are separate module instances and would otherwise register twice (NEXT-3).
 *
 * Web and worker create the same set and each serves its own (D-84): a series only moves in the
 * process that does the work, so dashboards sum over both. Every label value comes from a fixed set
 * in our own code, never an id, name, address or coordinate (D-53).
 *
 * The fixed sets are the `as const` arrays below, one per label. The types at the emit sites derive
 * from them, and a counter made with fixedCounter() accepts no other value and has every series at 0
 * from startup (PROM-1). Names, labels and values are a contract with the dashboard and the alert
 * rules in ops/ (D-85): add values, never rename them.
 */
import { constantTimeEqual } from '@hub/core';
import { OFFBOARD_REASONS } from '@hub/db';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import type { ApiAuthFailure } from './api';
import { RecentMinuteCounts } from './recent-counts';

/** Minutes of unarchived ingest responses kept for the ingest health chart (HEALTH_MINUTES). */
export const RECENT_REJECTION_MINUTES = 60;

/** The worker's pg-boss jobs: the `job_name` label of the hub_job_* metrics. */
export const JOB_NAMES = [
  'close-stale-sessions',
  'reverify-members',
  'expire-grace',
  'prune-audit-log',
  'sync-hiscores',
] as const;
export type JobName = (typeof JOB_NAMES)[number];

/** hub_job_runs_total{result}. */
export const JOB_RESULTS = ['success', 'failure'] as const;
export type JobResult = (typeof JOB_RESULTS)[number];

/** hub_pair_attempts_total{result}: how a pairing request ended (pairing/pair.ts). */
export const PAIR_RESULTS = [
  'decommissioned',
  'locked_out',
  'rate_limited_global',
  'rate_limited_ip',
  'malformed',
  'outdated',
  'invalid',
  'inactive',
  'paired',
  'unavailable',
  'error',
] as const;
export type PairResult = (typeof PAIR_RESULTS)[number];

/** hub_ingest_ignored_total{reason}: why an accepted payload stored nothing (IgnoredReason). */
export const INGEST_IGNORED_REASONS = ['no_identity', 'blocked'] as const;

/** hub_discord_verify_failures_total{kind}: why a member lookup failed (MemberLookup's reason). */
export const DISCORD_VERIFY_FAILURE_KINDS = [
  'config',
  'auth',
  'rate_limited',
  'unavailable',
] as const;
export type DiscordVerifyFailureKind = (typeof DISCORD_VERIFY_FAILURE_KINDS)[number];

/** hub_discord_verify_checks_total{verdict}. */
export const DISCORD_VERIFY_VERDICTS = ['member', 'not_member', 'missing_role', 'error'] as const;

/** hub_discord_verify_breaker_trips_total{rule}: the per-batch and the rolling breaker (D-62). */
export const DISCORD_VERIFY_BREAKER_RULES = ['batch', 'window'] as const;
export type DiscordVerifyBreakerRule = (typeof DISCORD_VERIFY_BREAKER_RULES)[number];

/**
 * hub_hiscore_lookups_total{result}: how an account's hiscores lookup ended (hiscores/sync.ts).
 * `throttled` pauses every lookup for a while (a 429, a 403, a 5xx, a page that isn't the hiscores);
 * `error` is a network failure or a timeout, which pauses them too.
 */
export const HISCORE_LOOKUP_RESULTS = [
  'ok',
  'not_found',
  'mismatch',
  'throttled',
  'error',
] as const;
export type HiscoreLookupResult = (typeof HISCORE_LOOKUP_RESULTS)[number];

/** hub_accounts_deleted_total{cause}. */
export const ACCOUNT_DELETION_CAUSES = ['grace_expiry', 'orphan_purge'] as const;

/** hub_data_exports_total{result}. */
export const DATA_EXPORT_RESULTS = ['completed', 'failed', 'cancelled', 'rate_limited'] as const;

/** hub_api_rate_limited_total{limit}. */
export const API_RATE_LIMITS = ['key', 'snapshot', 'auth_ip'] as const;

/** hub_api_auth_failures_total{reason}: the reasons authenticateApiKey gives (api/keys.ts). */
export const API_AUTH_FAILURES = [
  'missing',
  'malformed',
  'unknown',
  'revoked',
  'expired',
  'inactive_user',
] as const satisfies readonly ApiAuthFailure[];

/** Route groups of the public API: the `group` label of the hub_api_* metrics. */
export const API_ROUTE_GROUPS = [
  'me',
  'accounts',
  'events',
  'snapshot',
  'xp',
  'locations',
  'leaderboards',
  'hiscores',
  'members',
  'openapi',
  'unknown',
] as const;
export type ApiRouteGroup = (typeof API_ROUTE_GROUPS)[number];

/**
 * A counter whose labels only take values of fixed sets: inc() refuses anything else at compile
 * time, so a new value has to be added to the label's array above, which also creates it at 0.
 */
export interface FixedCounter<L extends Record<string, string>> {
  inc(labels: L, value?: number): void;
  get: Counter<keyof L & string>['get'];
}

/**
 * A counter with one label of a fixed value set, every series created at 0. prom-client creates a
 * labelled series on its first inc(), already at 1, and increase() over a series that appears at 1
 * is 0: the first breaker trip or refused key after a restart would never alert (PROM-1).
 */
function fixedCounter<L extends string, V extends string>(
  registry: Registry,
  def: { name: string; help: string; label: L; values: readonly V[] },
): FixedCounter<Record<L, V>> {
  const counter = new Counter<string>({
    name: def.name,
    help: def.help,
    labelNames: [def.label],
    registers: [registry],
  });
  for (const value of def.values) counter.inc({ [def.label]: value }, 0);
  return counter;
}

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
    ingestIgnored: fixedCounter(registry, {
      name: 'hub_ingest_ignored_total',
      help: 'Payloads accepted but ignored, by reason',
      label: 'reason',
      values: INGEST_IGNORED_REASONS,
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
    pairAttempts: fixedCounter(registry, {
      name: 'hub_pair_attempts_total',
      help: 'Pairing attempts by result',
      label: 'result',
      values: PAIR_RESULTS,
    }),
    sseConnections: new Gauge({
      name: 'hub_sse_connections',
      help: 'Open live (SSE) connections',
      registers: [registry],
    }),
    /**
     * Ingest responses whose body was never archived (401, 410, 413, 429, outdated plugin), per
     * minute and status, for the ingest health chart (D-83). Not exported to Prometheus.
     */
    ingestUnarchived: new RecentMinuteCounts(RECENT_REJECTION_MINUTES),
    discordVerifyFailures: fixedCounter(registry, {
      name: 'hub_discord_verify_failures_total',
      help: 'Discord membership checks that failed (errors, not "not a member")',
      label: 'kind',
      values: DISCORD_VERIFY_FAILURE_KINDS,
    }),
    discordVerifyChecks: fixedCounter(registry, {
      name: 'hub_discord_verify_checks_total',
      help: 'Discord membership re-verifications by verdict (member, not_member, missing_role, error)',
      label: 'verdict',
      values: DISCORD_VERIFY_VERDICTS,
    }),
    discordVerifyBreakerTrips: fixedCounter(registry, {
      name: 'hub_discord_verify_breaker_trips_total',
      help: 'Re-verification runs a circuit breaker stopped (nobody offboarded), by rule',
      label: 'rule',
      values: DISCORD_VERIFY_BREAKER_RULES,
    }),
    offboardedUsers: fixedCounter(registry, {
      name: 'hub_offboarded_users_total',
      help: 'Active users moved into grace, by reason (self_delete: Delete my data)',
      label: 'reason',
      values: OFFBOARD_REASONS,
    }),
    graceExpiredUsers: new Counter({
      name: 'hub_grace_expired_users_total',
      help: 'Users deleted when their grace period ended',
      registers: [registry],
    }),
    accountsDeleted: fixedCounter(registry, {
      name: 'hub_accounts_deleted_total',
      help: 'OSRS accounts deleted with their data, by cause (grace_expiry, orphan_purge)',
      label: 'cause',
      values: ACCOUNT_DELETION_CAUSES,
    }),
    dataExports: fixedCounter(registry, {
      name: 'hub_data_exports_total',
      help: 'Download my data requests by result (completed, failed, cancelled, rate_limited)',
      label: 'result',
      values: DATA_EXPORT_RESULTS,
    }),
    hiscoreLookups: fixedCounter(registry, {
      name: 'hub_hiscore_lookups_total',
      help: 'Official hiscores lookups by result (ok, not_found, mismatch, throttled, error)',
      label: 'result',
      values: HISCORE_LOOKUP_RESULTS,
    }),
    hiscoreXpFills: new Counter({
      name: 'hub_hiscore_xp_fills_total',
      help: 'Lookups that added XP made outside RuneLite to an account (D-105)',
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
    apiRateLimited: fixedCounter(registry, {
      name: 'hub_api_rate_limited_total',
      help: 'Public API 429s by limit (key, snapshot, auth_ip)',
      label: 'limit',
      values: API_RATE_LIMITS,
    }),
    apiAuthFailures: fixedCounter(registry, {
      name: 'hub_api_auth_failures_total',
      help: 'Public API requests refused 401, by why the key failed',
      label: 'reason',
      values: API_AUTH_FAILURES,
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
    }) as FixedCounter<{ job_name: JobName; result: JobResult }>,
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
 * Creates the job series at 0 (PROM-1, as fixedCounter() does for the single-label counters): every
 * job × result, and each job's duration histogram.
 */
function initSeries(m: HubMetrics): void {
  for (const job_name of JOB_NAMES) {
    for (const result of JOB_RESULTS) m.jobRuns.inc({ job_name, result }, 0);
    m.jobDuration.zero({ job_name });
  }
}

export type HubMetrics = ReturnType<typeof create>;

/**
 * Bump whenever create() gains or changes a member. `next dev` re-evaluates this module on a hot
 * reload but keeps globalThis, so without it the old object (missing the new member) would be
 * handed to the new code until the dev server restarts. A new version starts fresh counters.
 */
const METRICS_VERSION = 5;

const g = globalThis as unknown as { __hubMetrics?: HubMetrics; __hubMetricsVersion?: number };

export function getMetrics(): HubMetrics {
  if (!g.__hubMetrics || g.__hubMetricsVersion !== METRICS_VERSION) {
    g.__hubMetrics = create();
    g.__hubMetricsVersion = METRICS_VERSION;
  }
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

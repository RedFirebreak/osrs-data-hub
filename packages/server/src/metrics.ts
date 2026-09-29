/**
 * Prometheus metrics (handoff §16). The registry lives on globalThis: Next.js route handlers and
 * RSC/server code are separate module instances and would otherwise register twice (NEXT-3).
 */
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

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
  };
  return m;
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

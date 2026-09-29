/**
 * The ingest pipeline for POST /api/osrs-data/events (handoff §3.2, §3.6, §7; ARCHITECTURE §6).
 * The route handler builds an IngestRequest, calls handleIngest and turns the PluginResponse into a
 * Response.
 */
export { handleIngest } from './handler';
export { createIngestLimiter, MAX_EVENTS_PER_PAYLOAD } from './limits';
export { ACCOUNT_LOCK_CLASS } from './store';
export type { IgnoredReason, IngestDeps, IngestMeta, IngestRequest } from './types';

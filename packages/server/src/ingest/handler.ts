/**
 * POST /api/osrs-data/events (handoff §7, ARCHITECTURE §6). Each step is a small function; the order
 * matters: nothing is read from an unauthenticated request, the body is read only after the version
 * gate, and everything after the archive insert records its outcome in raw_payloads.
 */
import {
  OVERALL,
  isSpecialWorld,
  meetsMinimumVersion,
  normalizeEvents,
  parsePayload,
  type NormalizeResult,
  type ParsedPayload,
} from '@hub/core';
import { isDataDbError, isTransientDbError, pgErrorCode, safeDbErrorMessage } from '@hub/db';
import { storedVersionText, type PluginResponse } from '../plugin/protocol';
import { archivePayload, finishArchive, type ArchiveRef } from './archive';
import {
  authenticateDevice,
  closeDeviceSessions,
  markDeviceOutdated,
  touchDevice,
  type IngestDevice,
} from './device';
import { findAccountByName, identityClaim, type AccountRef } from './identity';
import {
  INGEST_MIN_RETRY_AFTER_SECONDS,
  MAX_EVENTS_PER_PAYLOAD,
  eventTypeLabel,
  versionLabel,
} from './limits';
import * as res from './responses';
import { resolveSkillIds } from './skills';
import {
  AccountNotFoundError,
  ReporterRevokedError,
  storePayload,
  type StoreOutcome,
} from './store';
import type { IgnoredReason, IngestDeps, IngestMeta, IngestRequest } from './types';

/** State of one request, shared by the steps and the outcome bookkeeping. */
interface IngestRun {
  deps: IngestDeps;
  req: IngestRequest;
  recv: Date;
  /** performance.now() at the start (recv may come from a test clock). */
  startedAt: number;
  /** X-Osrs-Exporter-Version as stored on the device and archive (storedVersionText). */
  versionText: string | null;
  device: IngestDevice | null;
  /**
   * The archive row recordOutcome still has to finish. Stays null for a body archived with its final
   * status and meta in one statement (rejectUnparsable): there is nothing left to record on it.
   */
  archive: ArchiveRef | null;
  /** The body is in raw_payloads: a response without it is counted as unarchived instead (D-83). */
  archived: boolean;
  accountId: number | null;
  meta: IngestMeta;
}

/**
 * Handles one ingest request and never throws: every outcome is a PluginResponse with the status
 * the plugin needs (D-19, D-30). Every return path is timed (ingestLatency) and counted
 * (ingestPayloads{status}); every authenticated request counts its plugin version. After the body is
 * archived, the returned status and meta are recorded on the archive row; a response without an
 * archive row is counted per minute instead (ingestUnarchived, D-83), for the ingest health chart.
 */
export async function handleIngest(deps: IngestDeps, req: IngestRequest): Promise<PluginResponse> {
  const recv = deps.now?.() ?? new Date();
  const stopTimer = deps.metrics.ingestLatency.startTimer();
  const run: IngestRun = {
    deps,
    req,
    recv,
    startedAt: performance.now(),
    versionText: storedVersionText(req.versionHeader),
    device: null,
    archive: null,
    archived: false,
    accountId: null,
    meta: {},
  };
  let response: PluginResponse;
  try {
    response = await ingest(run);
  } catch (err) {
    response = errorResponse(run, err);
  }
  await recordOutcome(run, response);
  deps.metrics.ingestPayloads.inc({ status: String(response.status) });
  if (!run.archived) deps.metrics.ingestUnarchived.add(String(response.status), recv);
  stopTimer();
  return response;
}

/** Steps 1–10 of the pipeline; throws on database errors (mapped by errorResponse). */
async function ingest(run: IngestRun): Promise<PluginResponse> {
  const { deps, req } = run;
  if (await deps.isDecommissioned()) return res.gone();

  const device = await authenticateDevice(deps.db, req.token);
  if (device === null) return res.unauthorized();
  run.device = device;
  // Counted only once authenticated: the header is free text, and the label set is capped
  // (versionLabel), so a stranger's made-up versions must not use up the labels (D-57).
  deps.metrics.pluginVersions.inc({ version: versionLabel(deps.metrics, req.versionHeader) });

  if (!meetsMinimumVersion(req.versionHeader, deps.minPluginVersion)) {
    await markDeviceOutdated(deps.db, device.id, run.recv, run.versionText);
    return res.pluginOutdated();
  }

  const text = await readBody(run);
  if (text === null) return res.payloadTooLarge();

  const parsed = parsePayload(text);
  if (!parsed.ok) return rejectUnparsable(run, device, text, parsed.error);
  const payload = parsed.payload;

  const limited = checkRate(run, device, payload.events.length > 0);
  if (limited !== null) return limited;

  run.archive = await archivePayload(deps.db, {
    receivedAt: run.recv,
    deviceId: device.id,
    pluginVersion: run.versionText,
    body: text,
  });
  run.archived = true;
  const normalized = normalizeCapped(run, payload);
  return processPayload(run, device, payload, normalized);
}

/** Identity (D-29) and then the transaction. */
async function processPayload(
  run: IngestRun,
  device: IngestDevice,
  payload: ParsedPayload,
  normalized: NormalizeResult,
): Promise<PluginResponse> {
  const claim = identityClaim(payload.player);
  if (claim.kind === 'none') return handleNoIdentity(run, device, payload.state, normalized);

  let account: AccountRef;
  if (claim.kind === 'hash') {
    account = { kind: 'hash', accountHash: claim.accountHash };
  } else {
    const accountId = await findAccountByName(run.deps.db, claim.name, device.userId);
    if (accountId === null) return res.unknownAccount();
    run.deps.logger.warn(
      { deviceId: device.id, accountId },
      'ingest: payload without accountHash matched by name',
    );
    account = { kind: 'id', accountId };
  }

  const skillIds = await resolveSkillIds(run.deps.db, skillNamesToResolve(payload));
  let outcome: StoreOutcome;
  try {
    outcome = await storePayload(
      run.deps.db,
      {
        recv: run.recv,
        device,
        ip: run.req.ip,
        pluginVersion: run.versionText,
        account,
        payload,
        normalized,
        skillIds,
      },
      ({ attempt, pgCode }) => {
        run.deps.logger.warn({ deviceId: device.id, attempt, pgCode }, 'ingest: retrying');
      },
    );
  } catch (err) {
    // Deleted meanwhile (a hard delete): a name can't be matched any more (400), while a hash is
    // simply created again when the plugin resends (503).
    if (err instanceof AccountNotFoundError) {
      return account.kind === 'id' ? res.unknownAccount() : res.temporarilyUnavailable();
    }
    // Revoked or offboarded while the request was in flight: the same 401 as at the door (D-19).
    if (err instanceof ReporterRevokedError) return res.unauthorized();
    throw err;
  }
  return recordStored(run, outcome);
}

/**
 * Reads the body with the size cap (enforced while streaming by the host, not from Content-Length).
 * A failed read (the client went away mid-body) is answered 400: there is nothing to retry from.
 */
async function readBody(run: IngestRun): Promise<string | null> {
  try {
    return await run.req.readBody(run.deps.maxBodyBytes);
  } catch {
    throw new UnreadableBodyError();
  }
}

/** A body that couldn't be read: payload-side, so 400 (never a 5xx loop, PLUGIN-3). */
class UnreadableBodyError extends Error {
  constructor() {
    super('body read failed');
    this.name = 'UnreadableBodyError';
  }
}

/**
 * Invalid JSON (or a non-object root) is archived with its final status and answered 400. It takes a
 * rate-limit token like a snapshot-only payload (it carries no events anyone could lose): a device
 * sending unparsable bodies faster than the bucket allows gets 429 and nothing archived, so it can't
 * fill raw_payloads with 256 KB bodies (D-57).
 */
async function rejectUnparsable(
  run: IngestRun,
  device: IngestDevice,
  text: string,
  error: 'not_json' | 'not_object',
): Promise<PluginResponse> {
  const limited = checkRate(run, device, false);
  if (limited !== null) return limited;
  await archivePayload(run.deps.db, {
    receivedAt: run.recv,
    deviceId: device.id,
    pluginVersion: run.versionText,
    body: text,
    status: 400,
    meta: { error },
  });
  // Archived, so not "rejected, not archived" (D-83); run.archive stays null because the row is
  // already final, and recordOutcome would replace its meta (the parser's error) with the response's.
  run.archived = true;
  return res.invalidJson();
}

/**
 * Per-device token bucket (handoff §7.6). Every payload takes a token, but only payloads without
 * events are refused, with a whole-second Retry-After of at least 3 (PLUGIN-5): the plugin drops
 * snapshots while paused and the next snapshot carries the full state, whereas event payloads must
 * never be refused (they would only queue). Null = go on.
 */
function checkRate(
  run: IngestRun,
  device: IngestDevice,
  hasEvents: boolean,
): PluginResponse | null {
  const result = run.deps.limiter.take(device.id);
  if (result.ok || hasEvents) return null;
  return res.rateLimited(Math.max(INGEST_MIN_RETRY_AFTER_SECONDS, result.retryAfterSeconds));
}

/**
 * normalizeEvents over at most MAX_EVENTS_PER_PAYLOAD events; parser-skipped, normalizer-skipped and
 * over-cap events all count as skipped (meta and metrics), as do skipped sections.
 */
function normalizeCapped(run: IngestRun, payload: ParsedPayload): NormalizeResult {
  const capped = payload.events.slice(0, MAX_EVENTS_PER_PAYLOAD);
  const normalized = normalizeEvents(capped, run.recv);
  const skippedEvents =
    payload.skipped.events + (payload.events.length - capped.length) + normalized.skipped;
  const { sections, reasons } = payload.skipped;
  if (sections.length > 0) run.meta.skippedSections = sections;
  if (reasons.length > 0) run.meta.skippedReasons = reasons;
  if (skippedEvents > 0) run.meta.skippedEvents = skippedEvents;
  run.deps.metrics.ingestSkippedSections.inc(sections.length);
  run.deps.metrics.ingestSkippedEvents.inc(skippedEvents);
  return normalized;
}

/**
 * No usable identity (no player, or a partial one without name and hash; D-29, PLUGIN-1): 200.
 * A clientShutdown in it closes this device's open sessions and ends those accounts' presence;
 * otherwise the payload is ignored. Either way the device's own presence is refreshed.
 */
async function handleNoIdentity(
  run: IngestRun,
  device: IngestDevice,
  state: string | null,
  normalized: NormalizeResult,
): Promise<PluginResponse> {
  await touchDevice(run.deps.db, device.id, run.recv, run.req.ip, run.versionText);
  if (normalized.shutdown !== null) {
    run.meta.closedSessions = await closeDeviceSessions(
      run.deps.db,
      device.id,
      normalized.shutdown,
      state,
    );
    return res.ok();
  }
  return ignored(run, 'no_identity');
}

function ignored(run: IngestRun, reason: IgnoredReason): PluginResponse {
  run.meta.ignored = reason;
  run.deps.metrics.ingestIgnored.inc({ reason });
  return res.ok();
}

/**
 * Skill names whose ids the plan may need: every sent skill plus the derived Overall. Special-world
 * payloads never write XP, so their (possibly league-only) names aren't added to the table.
 */
function skillNamesToResolve(payload: ParsedPayload): string[] {
  const skills = payload.player?.skills;
  if (skills === undefined || isSpecialWorld(payload.player?.worldTypes)) return [];
  return [OVERALL, ...Object.keys(skills)];
}

/** Meta, metrics and logs for a committed (or blocked) payload; always 200 (also all-duplicate). */
function recordStored(run: IngestRun, outcome: StoreOutcome): PluginResponse {
  const { deps, meta } = run;
  run.accountId = outcome.accountId;
  if (outcome.kind === 'blocked') return ignored(run, 'blocked');

  meta.inserted = outcome.inserted.length;
  meta.duplicates = outcome.duplicates;
  if (outcome.stale) meta.stale = true;
  if (outcome.special) meta.special = true;
  for (const { type } of outcome.inserted) {
    deps.metrics.ingestEvents.inc({ type: eventTypeLabel(type) });
  }
  deps.metrics.ingestDuplicates.inc(outcome.duplicates);
  if (outcome.xpGuardSkill !== null) {
    meta.xpGuard = outcome.xpGuardSkill;
    deps.logger.warn(
      { accountId: outcome.accountId, skill: outcome.xpGuardSkill },
      'ingest: XP dropped on a normal world; snapshot treated as special (D-24)',
    );
  }
  if (outcome.newAccount) {
    deps.logger.info(
      { accountId: outcome.accountId, deviceId: run.device?.id },
      'ingest: new account',
    );
  }
  return res.ok();
}

/**
 * Maps a thrown error to a status (D-19, D-30): transient database faults → 503 + Retry-After 30
 * (the plugin queues and resends; events are idempotent); errors the payload itself causes (a data
 * exception, an unreadable body, a RangeError/SyntaxError from its values) → 400, because a
 * deterministic 5xx blocks the plugin's queue (PLUGIN-3); anything else → 500 and an error log with
 * the SQLSTATE and a message free of bound parameters (DB-3).
 */
function errorResponse(run: IngestRun, err: unknown): PluginResponse {
  const { logger } = run.deps;
  const pgCode = pgErrorCode(err);
  if (pgCode !== undefined) run.meta.pgCode = pgCode;
  const context = { deviceId: run.device?.id, accountId: run.accountId ?? undefined, pgCode };
  if (isTransientDbError(err)) {
    logger.warn(context, 'ingest: transient database error');
    return res.temporarilyUnavailable();
  }
  if (isPayloadError(err)) {
    logger.warn({ ...context, error: errorName(err) }, 'ingest: payload rejected');
    return res.invalidPayload();
  }
  logger.error(
    {
      ...context,
      error: errorName(err),
      message: safeDbErrorMessage(err),
      frames: stackFrames(err),
    },
    'ingest: failed',
  );
  return res.internalError();
}

function isPayloadError(err: unknown): boolean {
  return (
    isDataDbError(err) ||
    err instanceof UnreadableBodyError ||
    err instanceof RangeError ||
    err instanceof SyntaxError
  );
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

/**
 * Only the "at …" frames of the stack: the message part (which can span lines) of a query error
 * holds its bound parameters (DB-3).
 */
function stackFrames(err: unknown): string | undefined {
  if (!(err instanceof Error) || err.stack === undefined) return undefined;
  const frames = err.stack
    .split('\n')
    .filter((line) => /^\s+at /.test(line))
    .slice(0, 10);
  return frames.length > 0 ? frames.join('\n') : undefined;
}

/** Records status, meta and account on the archive row (only once the body was archived). */
async function recordOutcome(run: IngestRun, response: PluginResponse): Promise<void> {
  if (run.archive === null) return;
  if (response.status !== 200) run.meta.error = res.responseError(response);
  run.meta.ms = Math.round(performance.now() - run.startedAt);
  await finishArchive(run.deps.db, run.deps.logger, run.archive, {
    status: response.status,
    meta: run.meta,
    accountId: run.accountId,
  });
}

/**
 * POST /api/osrs-data/pair (handoff §3.1, §6.2): the plugin sends {"code":"12345"} and its version
 * header; on success it gets a device token, shown exactly once (only sha256(token) is stored). Every
 * non-2xx carries a JSON `error`, which v1.5 shows in its pairing dialog (≤ 200 characters).
 */
import {
  generateDeviceToken,
  isValidPairingCode,
  meetsMinimumVersion,
  parsePluginVersion,
  sha256Hex,
} from '@hub/core';
import {
  devices,
  isTransientDbError,
  pairingCodes,
  pgErrorCode,
  safeDbErrorMessage,
  users,
  type Db,
  type Tx,
} from '@hub/db';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { audit } from '../audit';
import type { Logger } from '../logger';
import type { HubMetrics, PairResult } from '../metrics';
import { notifyPairing } from '../notify';
import {
  TRANSIENT_RETRY_AFTER_SECONDS,
  storedVersionText,
  type PluginResponse,
} from '../plugin/protocol';
import { pairRateKey, type PairLimits } from './limits';

/** "HA Exporter 1.5 or newer is required. …" for a MIN_PLUGIN_VERSION ("1.5.1" keeps its patch). */
export function outdatedPluginMessage(minPluginVersion: string): string {
  const v = parsePluginVersion(minPluginVersion);
  const shown = v ? `${v[0]}.${v[1]}${v[2] > 0 ? `.${v[2]}` : ''}` : minPluginVersion;
  return `HA Exporter ${shown} or newer is required. Restart RuneLite to update the plugin, then press Submit again.`;
}

/** The `error` texts the plugin shows (handoff §6.2.6); `outdated` is for the default minimum 1.5. */
export const PAIR_MESSAGES = {
  outdated: outdatedPluginMessage('1.5'),
  malformed: 'Missing or malformed pairing code. Enter the 5-digit code shown by the hub.',
  invalid: 'Invalid or expired pairing code',
  rateLimited: 'Too many attempts, try again in a few minutes',
  inactive:
    'The hub account that created this code is not active. Sign in to the hub again and create a new code.',
  unavailable: 'The hub is busy, try again in a minute',
  failed: 'Pairing failed because of a hub error, try again later',
  decommissioned: 'This hub no longer accepts new devices.',
} as const;

export interface PairDeps {
  db: Db;
  /** MIN_PLUGIN_VERSION, e.g. "1.5". */
  minPluginVersion: string;
  /** HUB_NAME: the plugin uses it as the connection's name (≤ 64 characters). */
  hubName: string;
  limits: PairLimits;
  logger: Logger;
  metrics: HubMetrics;
  /**
   * The admin decommission switch (settings isDecommissioned): true → 410 before anything else, as
   * ingest answers, so a decommissioned hub doesn't hand out tokens that would only ever get 410.
   * Optional so callers without the switch (tests) keep pairing.
   */
  isDecommissioned?: () => boolean | Promise<boolean>;
  now?: () => Date;
}

export interface PairRequest {
  /** X-Osrs-Exporter-Version, or null when missing. */
  versionHeader: string | null;
  /** Client IP (D-42), or null when unknown. */
  ip: string | null;
  /** The raw request body (the route caps its size), or null when there is none. */
  body: string | null;
}

interface Outcome {
  /** The pairAttempts{result} label. */
  result: PairResult;
  response: PluginResponse;
}

/** Longest wait for a row lock and for one statement, well inside the plugin's 10 s (PLUGIN-4). */
const LOCK_TIMEOUT = '3s';
const STATEMENT_TIMEOUT = '5s';

/**
 * Handles one pairing request, in this order:
 * 0. The decommission switch (deps.isDecommissioned) → 410 (D-19, D-56).
 * 1. Rate limits, keyed by pairRateKey(ip): an active lockout, then 10 per 10 min per client, then
 *    60/min globally. Each answers 429 with an integer Retry-After (PLUGIN-5). An attempt one limit
 *    refuses counts towards none of them, so a single client can't use up the global limit.
 * 2. The body must be a JSON object whose `code` is a string of 5 ASCII digits (PLUGIN-6: never a
 *    number, never other Unicode digits), else 400.
 * 3. Version gate (D-1): below MIN_PLUGIN_VERSION or missing → 400 with the "restart RuneLite" text.
 *    The code is NOT consumed, but an active code records the attempt and the wizard is told
 *    (`outdated_plugin`), because older plugins don't show the error text. The response is identical
 *    whether or not the code exists.
 * 4. Consume the code atomically; none active → 403 and a failure towards the lockout. A code whose
 *    creator is no longer active → 403 and the code stays unconsumed. Otherwise the device is created,
 *    the wizard is told (`consumed`) and the pairing audited, all in one transaction.
 * 5. 200 {ok, token, device_id, name}.
 * A transient database failure answers 503 + Retry-After 30; anything else unexpected 500. The code
 * and the token are never logged.
 */
export async function handlePair(deps: PairDeps, req: PairRequest): Promise<PluginResponse> {
  const outcome = await pair(deps, req);
  deps.metrics.pairAttempts.inc({ result: outcome.result });
  return outcome.response;
}

async function pair(deps: PairDeps, req: PairRequest): Promise<Outcome> {
  try {
    if (await deps.isDecommissioned?.()) {
      return reject('decommissioned', 410, PAIR_MESSAGES.decommissioned);
    }
  } catch (err) {
    return failure(deps, err);
  }
  const key = pairRateKey(req.ip);
  const limited = checkRateLimits(deps.limits, key);
  if (limited) return limited;

  const code = parseCode(req.body);
  if (code === null) return reject('malformed', 400, PAIR_MESSAGES.malformed);

  try {
    return await pairWithCode(deps, req, { key, code });
  } catch (err) {
    return failure(deps, err);
  }
}

/** Steps 3–5 for a well-formed code. */
async function pairWithCode(
  deps: PairDeps,
  req: PairRequest,
  v: { key: string; code: string },
): Promise<Outcome> {
  const now = deps.now?.() ?? new Date();
  const version = storedVersionText(req.versionHeader);
  if (!meetsMinimumVersion(req.versionHeader, deps.minPluginVersion)) {
    await recordOutdatedAttempt(deps, { code: v.code, version, now });
    return reject('outdated', 400, outdatedPluginMessage(deps.minPluginVersion));
  }
  const consumed = await consumeCode(deps.db, { code: v.code, now, version, ip: req.ip });
  switch (consumed.kind) {
    case 'invalid':
      recordFailure(deps, v.key);
      return reject('invalid', 403, PAIR_MESSAGES.invalid);
    case 'inactive':
      return reject('inactive', 403, PAIR_MESSAGES.inactive);
    case 'paired':
      // A success deliberately doesn't clear the lockout's failures: that would let a guild member
      // interleave their own valid codes between guesses and never reach the lockout. Failures age
      // out with the lockout window instead.
      return paired(deps, consumed);
  }
}

function paired(deps: PairDeps, device: Extract<ConsumeResult, { kind: 'paired' }>): Outcome {
  deps.logger.info(
    { userId: device.userId, deviceId: device.deviceId, codeId: device.codeId },
    'device paired',
  );
  return {
    result: 'paired',
    response: {
      status: 200,
      body: {
        ok: true,
        token: device.token,
        device_id: device.deviceId,
        // The plugin keeps at most 64 characters of the connection name.
        name: Array.from(deps.hubName).slice(0, 64).join(''),
      },
      // The token exists exactly once, in this response: nothing may cache it.
      headers: { 'Cache-Control': 'no-store' },
    },
  };
}

/**
 * Lockout, then the client's own limit, then the global one. The client's limit is only peeked
 * before the global hit and recorded after it: an attempt its own limit refuses must not take a
 * global slot (one client sending an empty body every second would otherwise block pairing for
 * everybody without ever reaching the lockout), and one the global limit refuses doesn't use up the
 * client's allowance. Synchronous, so nothing runs between the peek and the hit.
 */
function checkRateLimits(limits: PairLimits, key: string): Outcome | null {
  const lockedFor = limits.lockout.lockedFor(key);
  if (lockedFor > 0) return rateLimited('locked_out', lockedFor);
  const perClient = limits.perIp.peek(key);
  if (!perClient.ok) return rateLimited('rate_limited_ip', perClient.retryAfterSeconds);
  const global = limits.global.hit('global');
  if (!global.ok) return rateLimited('rate_limited_global', global.retryAfterSeconds);
  limits.perIp.hit(key);
  return null;
}

/** 429 with an integer delta-seconds Retry-After: the plugin ignores anything else (PLUGIN-5). */
function rateLimited(result: PairResult, retryAfterSeconds: number): Outcome {
  const seconds = Math.max(1, Math.ceil(retryAfterSeconds));
  return reject(result, 429, PAIR_MESSAGES.rateLimited, { 'Retry-After': String(seconds) });
}

function reject(
  result: PairResult,
  status: number,
  error: string,
  headers?: Record<string, string>,
): Outcome {
  return { result, response: { status, body: { ok: false, error }, ...(headers && { headers }) } };
}

/** The code from `{"code":"12345"}`, or null for anything else (see isValidPairingCode, PLUGIN-6). */
function parseCode(body: string | null): string | null {
  if (!body) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const code: unknown = (parsed as Record<string, unknown>).code;
  return isValidPairingCode(code) ? code : null;
}

function activeCode(code: string, now: Date) {
  return and(
    eq(pairingCodes.code, code),
    isNull(pairingCodes.consumedAt),
    gt(pairingCodes.expiresAt, now),
  );
}

/**
 * Bounds how long a pairing transaction can wait: the plugin gives up after 10 s (PLUGIN-4), and a
 * consumed code whose 200 never arrived is lost to the player. A lock or statement timeout is
 * transient (503). set_config because SET LOCAL can't take a bind parameter (DB-11).
 */
async function setPairTimeouts(tx: Tx): Promise<void> {
  await tx.execute(
    sql`SELECT set_config('lock_timeout', ${LOCK_TIMEOUT}, true), set_config('statement_timeout', ${STATEMENT_TIMEOUT}, true)`,
  );
}

/**
 * Marks an active code with the outdated attempt and tells its wizard, in one transaction (the
 * notification is delivered on commit only, D-32). No match does nothing. Best effort: the player
 * still gets the "update the plugin" answer when this fails (a locked code row included, which
 * gives up after the lock timeout), since that is what they need to see.
 */
async function recordOutdatedAttempt(
  deps: PairDeps,
  v: { code: string; version: string | null; now: Date },
): Promise<void> {
  try {
    await deps.db.transaction(async (tx) => {
      await setPairTimeouts(tx);
      const rows = await tx
        .update(pairingCodes)
        .set({ lastOutdatedAttemptAt: v.now, lastOutdatedVersion: v.version })
        .where(activeCode(v.code, v.now))
        .returning({ id: pairingCodes.id, userId: pairingCodes.userId });
      for (const row of rows) {
        await notifyPairing(tx, {
          kind: 'outdated_plugin',
          userId: row.userId,
          codeId: row.id,
          version: v.version,
        });
      }
    });
  } catch (err) {
    deps.logger.warn(
      { pgCode: pgErrorCode(err), error: safeDbErrorMessage(err) },
      'pairing: could not record an outdated-plugin attempt',
    );
  }
}

type ConsumeResult =
  | { kind: 'invalid' }
  | { kind: 'inactive' }
  | { kind: 'paired'; token: string; deviceId: string; userId: string; codeId: string };

/**
 * Consumes an active code and creates the device in one transaction.
 *
 * The code's creator is locked FOR SHARE before the code is touched. Offboarding locks the user row
 * (FOR NO KEY UPDATE) before it sets `grace` and revokes the user's devices, so the two serialize:
 * either offboarding commits first and the code is refused here as inactive, or this commits first
 * and offboarding's revoke sees (and revokes) the new device. Without the lock, a device created
 * while the user was being offboarded escaped the revoke and came back to life on a return from
 * grace. User before code is also the order a hard delete takes (user row, then cascaded codes).
 *
 * The UPDATE … WHERE consumed_at IS NULL is the single-use guard: of two concurrent requests with
 * the same code, the second waits for the first's row lock and then no longer matches. An inactive
 * creator's code is left unconsumed (nothing is written).
 */
async function consumeCode(
  db: Db,
  v: { code: string; now: Date; version: string | null; ip: string | null },
): Promise<ConsumeResult> {
  return db.transaction(async (tx): Promise<ConsumeResult> => {
    await setPairTimeouts(tx);
    const [candidate] = await tx
      .select({ userId: pairingCodes.userId })
      .from(pairingCodes)
      .where(activeCode(v.code, v.now));
    if (!candidate) return { kind: 'invalid' };
    const [creator] = await tx
      .select({ status: users.status })
      .from(users)
      .where(eq(users.id, candidate.userId))
      .for('share');
    // No row: the user was deleted meanwhile, and their codes with them.
    if (!creator) return { kind: 'invalid' };
    if (creator.status !== 'active') return { kind: 'inactive' };

    const [code] = await tx
      .update(pairingCodes)
      .set({ consumedAt: v.now })
      .where(and(activeCode(v.code, v.now), eq(pairingCodes.userId, candidate.userId)))
      .returning({ id: pairingCodes.id, userId: pairingCodes.userId, label: pairingCodes.label });
    // Consumed by a concurrent request since the lookup.
    if (!code) return { kind: 'invalid' };
    return createDevice(tx, { ...v, code });
  });
}

/** The device for a just-consumed code, the wizard's notification and the audit entry. */
async function createDevice(
  tx: Tx,
  v: {
    code: { id: string; userId: string; label: string | null };
    now: Date;
    version: string | null;
    ip: string | null;
  },
): Promise<ConsumeResult> {
  const { code } = v;
  const token = generateDeviceToken();
  const [device] = await tx
    .insert(devices)
    .values({
      userId: code.userId,
      label: code.label,
      tokenHash: sha256Hex(token),
      pluginVersion: v.version,
      createdAt: v.now,
      lastIp: v.ip,
    })
    .returning({ id: devices.id });
  if (!device) throw new Error('device insert returned no row');
  await tx.update(pairingCodes).set({ deviceId: device.id }).where(eq(pairingCodes.id, code.id));
  await notifyPairing(tx, {
    kind: 'consumed',
    userId: code.userId,
    codeId: code.id,
    deviceId: device.id,
  });
  await audit(tx, {
    actorUserId: code.userId,
    action: 'device.paired',
    targetType: 'device',
    targetId: device.id,
    meta: { codeId: code.id, pluginVersion: v.version },
  });
  return { kind: 'paired', token, deviceId: device.id, userId: code.userId, codeId: code.id };
}

function recordFailure(deps: PairDeps, key: string): void {
  deps.limits.lockout.recordFailure(key);
  if (deps.limits.lockout.lockedFor(key) > 0) {
    // The key is an IP (prefix): personal data, so it isn't logged.
    deps.logger.warn('pairing: a client is locked out after repeated invalid codes');
  }
}

/** Transient database faults → 503 + Retry-After (the player presses Submit again); else 500. */
function failure(deps: PairDeps, err: unknown): Outcome {
  // DB-3: never log err.message of a database error (it contains the bound code and token hash).
  const logged = { pgCode: pgErrorCode(err), error: safeDbErrorMessage(err) };
  if (isTransientDbError(err)) {
    deps.logger.warn(logged, 'pairing: transient database error');
    return reject('unavailable', 503, PAIR_MESSAGES.unavailable, {
      'Retry-After': String(TRANSIENT_RETRY_AFTER_SECONDS),
    });
  }
  deps.logger.error(logged, 'pairing failed');
  return reject('error', 500, PAIR_MESSAGES.failed);
}

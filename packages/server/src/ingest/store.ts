/**
 * The ingest transaction (handoff §7.1 steps 6–14): one transaction per payload, serialized per
 * account, with every decision taken by @hub/core (planSnapshot, normalizeEvents) and only the writes
 * here. Nothing is marked "seen" before commit (D-16); NOTIFY is sent inside, so it is delivered on
 * commit only (D-32).
 */
import {
  XP_BUCKET_MS,
  floorTo,
  generatePublicId,
  isRecord,
  normalizeName,
  payloadTime,
  planSnapshot,
  stripNul,
  type ItemData,
  type LatestStatePatch,
  type Location,
  type NormalizeResult,
  type NormalizedEvent,
  type ParsedPayload,
  type PlayerSnapshot,
  type PrevState,
  type SnapshotPlan,
} from '@hub/core';
import {
  accountLinks,
  accountNames,
  deviceAccounts,
  devices,
  equipmentChanges,
  events,
  latestState,
  locationSamples,
  osrsAccounts,
  playSessions,
  users,
  wealthDaily,
  xpSamples,
  pgErrorCode,
  type Db,
  type Tx,
} from '@hub/db';
import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import { SYSTEM_ACTOR } from '../audit';
import { notifyEvents, notifyState } from '../notify';
import { takeOverFromOwnerInGrace } from '../offboarding/accounts';
import { chunkKeys, knownChunks, lockChunkCreation, rememberChunks } from './chunks';
import type { IngestDevice } from './device';
import type { AccountRef } from './identity';
import { lockAccount } from './lock';
import { gameStateAfterShutdown } from './presence';

/**
 * Both local to the transaction and well under the plugin's 10 s read timeout (PLUGIN-4): a lock wait
 * fails with 55P03 and a slow statement with 57014, both answered 503 + Retry-After.
 */
const LOCK_TIMEOUT = '3s';
const STATEMENT_TIMEOUT = '8s';
/** Name stored for an account first seen without one (it is replaced by the first real name). */
const UNKNOWN_NAME = 'Unknown';
/** Event rows per INSERT: 16 bind parameters each, far below Postgres' 65535 per statement. */
const EVENT_INSERT_CHUNK = 1000;

export interface StoreInput {
  recv: Date;
  device: IngestDevice;
  ip: string | null;
  /** X-Osrs-Exporter-Version as stored (trimmed, truncated). */
  pluginVersion: string | null;
  account: AccountRef;
  payload: ParsedPayload;
  /** normalizeEvents over the (capped) events of the payload. */
  normalized: NormalizeResult;
  /** skills.id for every name the plan may write (resolveSkillIds). */
  skillIds: ReadonlyMap<string, number>;
}

export type StoreOutcome =
  | {
      kind: 'stored';
      accountId: number;
      newAccount: boolean;
      stale: boolean;
      special: boolean;
      /** Skill whose XP dropped (the snapshot was then treated as special), or null. */
      xpGuardSkill: string | null;
      /** Event rows inserted by this payload. */
      inserted: { seq: number; type: string }[];
      /** Event rows that already existed. */
      duplicates: number;
    }
  /** The owner blocked this user: the transaction was rolled back, nothing is stored. */
  | { kind: 'blocked'; accountId: number };

/** The payload's account disappeared (a hard delete) between lookup and transaction. */
export class AccountNotFoundError extends Error {
  constructor() {
    super('account not found');
    this.name = 'AccountNotFoundError';
  }
}

/**
 * The reporting device was revoked, or its user left `active` (offboarding), after authenticateDevice
 * let the request in: the caller answers 401 like any other revoked device (D-19).
 */
export class ReporterRevokedError extends Error {
  constructor() {
    super('device revoked or user not active');
    this.name = 'ReporterRevokedError';
  }
}

/** Thrown inside the transaction to roll it back when the contributor is blocked. */
class BlockedContributor extends Error {
  constructor(readonly accountId: number) {
    super('blocked contributor');
  }
}

/**
 * SQLSTATEs after which the whole transaction is simply run again (it is idempotent, and nothing was
 * committed): deadlock, serialization failure, and a unique violation from a concurrent insert race
 * (DB-9). A lock or statement timeout is not retried: its time is already spent (PLUGIN-4).
 */
const RETRYABLE_CODES: ReadonlySet<string> = new Set(['40P01', '40001', '23505']);
const MAX_ATTEMPTS = 3;
/**
 * No new attempt starts once this much time has passed since the first one: an attempt can spend
 * seconds in lock waits before its deadlock is detected, and the whole request must stay well under
 * the plugin's 10 s read timeout (PLUGIN-4). Past it the caller answers 503 and the plugin resends.
 */
const RETRY_BUDGET_MS = 2_500;

/**
 * Stores one payload for one account. A new account is created first, on its own and committed at
 * once (findOrCreateAccount); then one transaction does the rest, retried on a deadlock or a racing
 * unique violation (RETRYABLE_CODES) within MAX_ATTEMPTS and RETRY_BUDGET_MS, with `onRetry` told
 * each time. Order inside (handoff §7.1): the reporting user's row (lockReporter: a revoke or an
 * offboarding committed meanwhile refuses the payload), the per-account advisory lock, link the user
 * (a blocked link rolls everything back: "store nothing"), device bookkeeping, plan the snapshot against
 * latest_state, then presence and latest_state, XP samples, equipment/location/wealth, play
 * sessions, the account row (last seen, owner, name, a D-60 takeover), and the events LAST so the
 * transaction holds its event seqs as briefly as possible (DB-4). Other database errors are thrown
 * unchanged; the caller maps them to status codes.
 */
export async function storePayload(
  db: Db,
  input: StoreInput,
  onRetry?: (info: { attempt: number; pgCode: string }) => void,
): Promise<StoreOutcome> {
  const started = performance.now();
  const known = knownChunks(db);
  let created = false;
  for (let attempt = 1; ; attempt++) {
    try {
      const account = await findOrCreateAccount(
        db,
        input.account,
        input.payload.player,
        input.recv,
      );
      created ||= account.created;
      const { outcome, chunks } = await db.transaction((tx) =>
        storeInTransaction(tx, input, { accountId: account.id, newAccount: created, known }),
      );
      rememberChunks(known, chunks);
      return outcome;
    } catch (err) {
      if (err instanceof BlockedContributor) return { kind: 'blocked', accountId: err.accountId };
      const pgCode = pgErrorCode(err);
      const retryable = pgCode !== undefined && RETRYABLE_CODES.has(pgCode);
      if (!retryable || attempt >= MAX_ATTEMPTS || performance.now() - started >= RETRY_BUDGET_MS) {
        throw err;
      }
      onRetry?.({ attempt, pgCode });
      await sleep(10 + Math.random() * 40);
    }
  }
}

/**
 * One attempt of the transaction. Returns the outcome and the hypertable chunk ranges it wrote to
 * (recorded once committed, see ./chunks).
 */
async function storeInTransaction(
  tx: Tx,
  input: StoreInput,
  opts: { accountId: number; newAccount: boolean; known: ReadonlySet<string> },
): Promise<{ outcome: StoreOutcome; chunks: string[] }> {
  const { accountId, newAccount } = opts;
  const { recv, device, payload, normalized } = input;
  const player: PlayerSnapshot = payload.player ?? {};

  await setLocalTimeouts(tx);
  await lockReporter(tx, device.userId);
  await lockAccount(tx, accountId);
  await assertAccountExists(tx, accountId);
  await linkUser(tx, accountId, device.userId, recv);
  await touchDeviceAccount(tx, device.id, accountId, recv);
  const firstDataForDevice = await touchDeviceWithData(tx, input);

  const prev = await loadPrevState(tx, accountId);
  const plan = planSnapshot(prev, payload, {
    recv,
    deviceId: device.id,
    payloadTs: payloadTime(payload.timestamp, recv),
  });

  await upsertLatestState(tx, accountId, input, plan);
  // See TSDB-12: one chunk creator at a time, before the first hypertable write.
  const chunks = chunkKeys(plan, recv);
  await lockChunkCreation(tx, opts.known, chunks);
  await writeXpSamples(tx, accountId, recv, plan, input.skillIds);
  await writeDerived(tx, accountId, recv, plan);
  await updateSession(tx, accountId, device.id, recv, plan, normalized.shutdown);
  await updateAccount(tx, accountId, device.userId, recv, appliesSnapshot(plan) ? player : {});
  const { inserted, duplicates } = await insertEvents(tx, accountId, input, plan.special);

  if (inserted.length > 0) {
    await notifyEvents(tx, { accountId, seqs: inserted.map((r) => r.seq) });
  }
  await notifyState(tx, { accountId, deviceId: device.id, firstDataForDevice });

  return {
    outcome: {
      kind: 'stored',
      accountId,
      newAccount,
      stale: plan.stale,
      special: plan.special,
      xpGuardSkill: plan.xpGuardTripped ? plan.xpGuardSkill : null,
      inserted,
      duplicates,
    },
    chunks,
  };
}

/** Transaction-local timeouts; set_config because SET takes no bind parameters (DB-11). */
export async function setLocalTimeouts(tx: Tx): Promise<void> {
  await tx.execute(
    sql`SELECT set_config('lock_timeout', ${LOCK_TIMEOUT}, true), set_config('statement_timeout', ${STATEMENT_TIMEOUT}, true)`,
  );
}

/**
 * The account's id; a new accountHash is created here, OUTSIDE the ingest transaction, in one
 * autocommitted statement. Why: creating a new xp_samples/location_samples chunk takes a
 * ShareRowExclusiveLock on osrs_accounts (the hypertables' FK target), which waits for every open
 * transaction that has written osrs_accounts. An INSERT at the start of the ingest transaction held
 * that write for its whole length, so a payload creating a chunk and a new account's payload
 * deadlocked (40P01), and their retries collided again. The ingest transaction now writes
 * the row only late (updateAccount). A payload whose transaction then fails leaves the bare account
 * (no link, no owner) for its resend or the next payload to fill in.
 */
async function findOrCreateAccount(
  db: Db,
  ref: AccountRef,
  player: PlayerSnapshot | null,
  recv: Date,
): Promise<{ id: number; created: boolean }> {
  if (ref.kind === 'id') return { id: ref.accountId, created: false };
  const [found] = await db
    .select({ id: osrsAccounts.id })
    .from(osrsAccounts)
    .where(eq(osrsAccounts.accountHash, ref.accountHash));
  if (found) return { id: found.id, created: false };
  return createAccount(db, ref.accountHash, player ?? {}, recv);
}

/**
 * INSERT … ON CONFLICT (account_hash) DO UPDATE … RETURNING: returns the row to BOTH of two
 * concurrent first payloads, where DO NOTHING would return nothing to the loser and a plain INSERT
 * would fail it with 23505 (DB-9). `xmax = 0` tells whether this statement inserted it; only then is
 * the first account_names row added, in the same statement. A new account without a name gets the
 * placeholder "Unknown" with an EMPTY name_normalized (no account_names row), so a name-only lookup
 * can never match the placeholder.
 */
async function createAccount(
  db: Db,
  accountHash: string,
  player: PlayerSnapshot,
  recv: Date,
): Promise<{ id: number; created: boolean }> {
  const at = recv.toISOString();
  const name = player.name ?? null;
  const result = await db.execute<{ id: number; created: boolean }>(sql`
    WITH account AS (
      INSERT INTO osrs_accounts
        (public_id, account_hash, current_name, name_normalized, account_type, first_seen, last_seen)
      VALUES (${generatePublicId()}, ${accountHash}, ${name ?? UNKNOWN_NAME},
              ${name === null ? '' : normalizeName(name)}, ${player.accountType ?? null}::smallint,
              ${at}::timestamptz, ${at}::timestamptz)
      ON CONFLICT (account_hash)
        DO UPDATE SET last_seen = GREATEST(osrs_accounts.last_seen, excluded.last_seen)
      RETURNING id, (xmax = 0) AS created
    ), first_name AS (
      INSERT INTO account_names (account_id, name, first_seen, last_seen)
      SELECT id, ${name}::text, ${at}::timestamptz, ${at}::timestamptz
      FROM account WHERE created AND ${name}::text IS NOT NULL
      ON CONFLICT DO NOTHING
    )
    SELECT id, created FROM account`);
  const [row] = result.rows;
  if (!row) throw new Error('account upsert returned no row');
  return row;
}

/**
 * The account can disappear between findOrCreateAccount and the lock (a hard delete); the FK inserts
 * would then fail as a data error (400). AccountNotFoundError lets the caller answer properly.
 */
async function assertAccountExists(tx: Tx, accountId: number): Promise<void> {
  const [row] = await tx
    .select({ id: osrsAccounts.id })
    .from(osrsAccounts)
    .where(eq(osrsAccounts.id, accountId));
  if (!row) throw new AccountNotFoundError();
}

/**
 * Locks the reporting user's row FOR SHARE and checks that they are still active. authenticateDevice
 * ran before the transaction, and an offboarding may have committed since. Offboarding locks the
 * same row FOR NO KEY UPDATE before anything else, so the two now serialize: either the offboarding
 * committed first and this payload is refused (ReporterRevokedError → 401), or the payload commits
 * first and the offboarding then finds the account this user just became owner of and hides or
 * transfers it. Without the lock, a new account's first payload in flight during an offboarding made
 * the user in grace its owner and left it visible (handoff §10, §14.3). Pairing locks the code's
 * creator the same way. Taken before the account lock, because offboarding takes the user row and
 * then the account locks: the other order could deadlock with it (D-55).
 */
async function lockReporter(tx: Tx, userId: string): Promise<void> {
  const [user] = await tx
    .select({ status: users.status })
    .from(users)
    .where(eq(users.id, userId))
    .for('share');
  if (user?.status !== 'active') throw new ReporterRevokedError();
}

/**
 * Upserts account_links(account, user) as contributor (handoff §7.1.7). A blocked link rolls the
 * whole transaction back: "store nothing". Ownership is settled in updateAccount.
 */
async function linkUser(tx: Tx, accountId: number, userId: string, recv: Date): Promise<void> {
  const [link] = await tx
    .insert(accountLinks)
    .values({ accountId, userId, role: 'contributor', firstSeen: recv, lastSeen: recv })
    .onConflictDoUpdate({
      target: [accountLinks.accountId, accountLinks.userId],
      set: { lastSeen: sql`GREATEST(${accountLinks.lastSeen}, excluded.last_seen)` },
    })
    .returning({ blocked: accountLinks.blocked });
  if (link?.blocked) throw new BlockedContributor(accountId);
}

/**
 * The account row, written once and late (see findOrCreateAccount): last_seen, an unclaimed account
 * becomes this user's (first reporter is owner, D-21; COALESCE makes a concurrent claim safe) with
 * the link's role following, and — from an applied snapshot only (`identity` is empty otherwise) —
 * a rename (D-15: history is keyed by the id, so nothing else changes) or a new account type.
 *
 * A hidden account of someone else is checked for D-60: when its owner is in grace, the reporter (an
 * active user, lockReporter; with a non-blocked link, linkUser) takes it over and it becomes
 * visible. Hidden accounts are rare, so only they pay for the extra read. It runs here, after the
 * hypertable writes, because it writes osrs_accounts (TSDB-12), and under the account lock taken at
 * the start, like every owner change.
 */
async function updateAccount(
  tx: Tx,
  accountId: number,
  userId: string,
  recv: Date,
  identity: Pick<PlayerSnapshot, 'name' | 'accountType'>,
): Promise<void> {
  const [row] = await tx
    .update(osrsAccounts)
    .set({
      lastSeen: sql`GREATEST(${osrsAccounts.lastSeen}, ${recv.toISOString()}::timestamptz)`,
      ownerUserId: sql`COALESCE(${osrsAccounts.ownerUserId}, ${userId})`,
      // undefined keys are left out of the SET list.
      currentName: identity.name,
      nameNormalized: identity.name === undefined ? undefined : normalizeName(identity.name),
      accountType: identity.accountType,
    })
    .where(eq(osrsAccounts.id, accountId))
    .returning({ ownerUserId: osrsAccounts.ownerUserId, status: osrsAccounts.status });
  if (row?.ownerUserId === userId) {
    await tx
      .update(accountLinks)
      .set({ role: 'owner' })
      .where(
        and(
          eq(accountLinks.accountId, accountId),
          eq(accountLinks.userId, userId),
          ne(accountLinks.role, 'owner'),
        ),
      );
  } else if (row?.status === 'hidden') {
    // An ownership change ingest makes on its own (D-60) is the system's, not the reporter's choice.
    await takeOverFromOwnerInGrace(tx, accountId, userId, SYSTEM_ACTOR, recv);
  }
  if (identity.name !== undefined) await touchAccountName(tx, accountId, identity.name, recv);
}

async function touchDeviceAccount(
  tx: Tx,
  deviceId: string,
  accountId: number,
  recv: Date,
): Promise<void> {
  await tx
    .insert(deviceAccounts)
    .values({ deviceId, accountId, firstSeen: recv, lastSeen: recv })
    .onConflictDoUpdate({
      target: [deviceAccounts.deviceId, deviceAccounts.accountId],
      set: { lastSeen: sql`GREATEST(${deviceAccounts.lastSeen}, excluded.last_seen)` },
    });
}

/**
 * Device presence, IP and version, clears the outdated flag, and sets first_data_at once. Returns
 * whether this is the device's first payload with an account (the wizard's "receiving data" step).
 * The row is locked first, so two concurrent first payloads can't both report "first"; the locked
 * row is the latest version, so a revoke (Devices page) committed since authenticateDevice is seen
 * here and refuses the payload (ReporterRevokedError → 401) instead of storing it.
 */
async function touchDeviceWithData(tx: Tx, input: StoreInput): Promise<boolean> {
  const [before] = await tx
    .select({ firstDataAt: devices.firstDataAt, revokedAt: devices.revokedAt })
    .from(devices)
    .where(eq(devices.id, input.device.id))
    .for('update');
  if (before === undefined || before.revokedAt !== null) throw new ReporterRevokedError();
  const first = before.firstDataAt === null;
  await tx
    .update(devices)
    .set({
      lastSeenAt: input.recv,
      lastIp: input.ip,
      pluginVersion: input.pluginVersion,
      outdatedAt: null,
      ...(first ? { firstDataAt: input.recv } : {}),
    })
    .where(eq(devices.id, input.device.id));
  return first;
}

/** The previous latest_state as planSnapshot needs it (null for a new account). */
async function loadPrevState(tx: Tx, accountId: number): Promise<PrevState | null> {
  const [row] = await tx
    .select({
      sourceDeviceId: latestState.sourceDeviceId,
      sourceTs: latestState.sourceTs,
      skills: latestState.skills,
      equipment: latestState.equipment,
      gameState: latestState.gameState,
      world: latestState.world,
      location: latestState.location,
      locationUpdatedAt: latestState.locationUpdatedAt,
    })
    .from(latestState)
    .where(eq(latestState.accountId, accountId));
  if (!row) return null;
  return {
    ...row,
    // Written by this module from validated sections; the shape checks only guard against edits.
    skills: isRecord(row.skills) ? (row.skills as PrevState['skills']) : null,
    equipment: Array.isArray(row.equipment) ? (row.equipment as ItemData[]) : null,
    location: isLocation(row.location) ? row.location : null,
  };
}

function isLocation(value: unknown): value is Location {
  return (
    isRecord(value) &&
    typeof value.x === 'number' &&
    typeof value.y === 'number' &&
    typeof value.plane === 'number'
  );
}

/**
 * Whether the snapshot's own data is applied: not stale, not special, not XP-guarded. Only then do its
 * name and account type count, since a stale payload is older information and a special-world or
 * guarded one may be another character on the same hash (PLUGIN-8).
 */
function appliesSnapshot(plan: SnapshotPlan): boolean {
  return !plan.stale && !plan.special && !plan.xpGuardTripped;
}

/** Upserts account_names; an existing row's last_seen moves at most once a minute (cheap). */
async function touchAccountName(
  tx: Tx,
  accountId: number,
  name: string,
  recv: Date,
): Promise<void> {
  await tx
    .insert(accountNames)
    .values({ accountId, name, firstSeen: recv, lastSeen: recv })
    .onConflictDoUpdate({
      target: [accountNames.accountId, accountNames.name],
      set: { lastSeen: sql`excluded.last_seen` },
      setWhere: sql`${accountNames.lastSeen} < excluded.last_seen - interval '1 minute'`,
    });
}

/**
 * Presence ALWAYS (last_seen, last_device_id; also for stale snapshots, D-17), game_state unless the
 * snapshot is stale (D-33; a clientShutdown ends it, see gameStateAfterShutdown), tick_delay when
 * known (> 0), plus the plan's patch. Only the patch's keys are written, so a section missing from
 * the payload keeps its value and its *_updated_at (D-18).
 */
async function upsertLatestState(
  tx: Tx,
  accountId: number,
  input: StoreInput,
  plan: SnapshotPlan,
): Promise<void> {
  const { payload, recv } = input;
  const presence: Partial<typeof latestState.$inferInsert> = { lastDeviceId: input.device.id };
  if (!plan.stale) {
    const gameState = presenceGameState(payload.state, input.normalized.shutdown !== null);
    if (gameState !== undefined) presence.gameState = gameState;
  }
  if (payload.tickDelay > 0) presence.tickDelay = payload.tickDelay;
  const patch = storablePatch(plan.latestPatch);
  await tx
    .insert(latestState)
    .values({ accountId, lastSeen: recv, ...presence, ...patch, updatedAt: recv })
    .onConflictDoUpdate({
      target: latestState.accountId,
      set: {
        // GREATEST: a payload that waited for the account lock must not move presence backwards.
        lastSeen: sql`GREATEST(${latestState.lastSeen}, excluded.last_seen)`,
        ...presence,
        ...patch,
        updatedAt: recv,
      },
    });
}

/** game_state to write (undefined = keep): the payload's, or the shutdown rule's when it has one. */
function presenceGameState(state: string | null, shutdown: boolean): string | null | undefined {
  return shutdown ? gameStateAfterShutdown(state) : (state ?? undefined);
}

/** The patch with its jsonb sections through stripNul (jsonb rejects \u0000, DB-1). */
function storablePatch(patch: LatestStatePatch | null): LatestStatePatch {
  if (patch === null) return {};
  const out: LatestStatePatch = { ...patch };
  if (patch.location !== undefined) out.location = stripNul(patch.location);
  if (patch.skills !== undefined) out.skills = stripNul(patch.skills);
  if (patch.inventory !== undefined) out.inventory = stripNul(patch.inventory);
  if (patch.equipment !== undefined) out.equipment = stripNul(patch.equipment);
  return out;
}

/**
 * XP samples in the 5-minute bucket of the RECEIVE time (D-23), one multi-row statement. XP only
 * goes up, so a bucket keeps the highest value it saw (GREATEST also absorbs out-of-order arrivals).
 */
async function writeXpSamples(
  tx: Tx,
  accountId: number,
  recv: Date,
  plan: SnapshotPlan,
  skillIds: ReadonlyMap<string, number>,
): Promise<void> {
  if (plan.xpWrites.length === 0) return;
  const bucket = floorTo(recv, XP_BUCKET_MS);
  const rows = plan.xpWrites.map((w) => {
    const skillId = skillIds.get(w.skill);
    if (skillId === undefined) throw new Error('skill id missing for an XP write');
    return { accountId, skillId, bucket, xp: w.xp, level: w.level };
  });
  await tx
    .insert(xpSamples)
    .values(rows)
    .onConflictDoUpdate({
      target: [xpSamples.accountId, xpSamples.skillId, xpSamples.bucket],
      set: {
        xp: sql`GREATEST(${xpSamples.xp}, excluded.xp)`,
        level: sql`GREATEST(${xpSamples.level}, excluded.level)`,
      },
    });
}

/**
 * Equipment change log, the location points and the day's carried wealth. A point whose
 * (account, ts) exists is left alone: the first sample of a minute wins, and a trail that arrives
 * twice (a resend, a second paired device) is stored once (D-102). That takes both copies getting
 * the same times, which a PC clock more than 10 s ahead undoes (PLUGIN-14).
 */
async function writeDerived(
  tx: Tx,
  accountId: number,
  recv: Date,
  plan: SnapshotPlan,
): Promise<void> {
  if (plan.equipmentChange !== null) {
    await tx
      .insert(equipmentChanges)
      .values({ accountId, changedAt: recv, equipment: stripNul(plan.equipmentChange) });
  }
  if (plan.locationPoints.length > 0) {
    await tx
      .insert(locationSamples)
      .values(plan.locationPoints.map((point) => ({ accountId, ...point })))
      .onConflictDoNothing();
  }
  if (plan.wealth !== null) {
    const { day, value } = plan.wealth;
    await tx
      .insert(wealthDaily)
      .values({ accountId, day, lastValue: value, maxValue: value, updatedAt: recv })
      .onConflictDoUpdate({
        target: [wealthDaily.accountId, wealthDaily.day],
        set: {
          lastValue: value,
          maxValue: sql`GREATEST(${wealthDaily.maxValue}, excluded.max_value)`,
          updatedAt: recv,
        },
      });
  }
}

/**
 * Play sessions (D-45: special worlds count too). An open session is extended by in-game payloads
 * (the world list grows) and ended by a clientShutdown at max(started_at, shutdown time). Without an
 * open session a LOGGED_IN payload opens one, unless the same payload shuts down: opening a session
 * only to close it would record a zero-length session (shutdown.json is LOGGED_IN + "Shutdown").
 */
async function updateSession(
  tx: Tx,
  accountId: number,
  deviceId: string,
  recv: Date,
  plan: SnapshotPlan,
  shutdown: NormalizeResult['shutdown'],
): Promise<void> {
  const [open] = await tx
    .select({ id: playSessions.id })
    .from(playSessions)
    .where(and(eq(playSessions.accountId, accountId), isNull(playSessions.endedAt)))
    .for('update');
  if (open === undefined) {
    if (plan.session.open && shutdown === null) {
      const world = plan.session.world;
      await tx.insert(playSessions).values({
        accountId,
        deviceId,
        startedAt: recv,
        lastSeenAt: recv,
        worlds: world === null ? [] : [world],
      });
    }
    return;
  }
  if (plan.session.extend) await extendSession(tx, open.id, deviceId, recv, plan.session.world);
  if (shutdown !== null) {
    await tx
      .update(playSessions)
      .set({
        endedAt: sql`GREATEST(${playSessions.startedAt}, ${shutdown.occurredAt.toISOString()}::timestamptz)`,
        endReason: shutdown.reason,
      })
      .where(eq(playSessions.id, open.id));
  }
}

async function extendSession(
  tx: Tx,
  sessionId: string,
  deviceId: string,
  recv: Date,
  world: number | null,
): Promise<void> {
  const worlds =
    world === null
      ? undefined
      : sql`CASE WHEN ${world}::integer = ANY(${playSessions.worlds}) THEN ${playSessions.worlds}
             ELSE array_append(${playSessions.worlds}, ${world}::integer) END`;
  await tx
    .update(playSessions)
    .set({
      lastSeenAt: sql`GREATEST(${playSessions.lastSeenAt}, ${recv.toISOString()}::timestamptz)`,
      deviceId,
      worlds,
    })
    .where(eq(playSessions.id, sessionId));
}

/**
 * The events, normalized by @hub/core, with the one dedupe mechanism: ON CONFLICT on
 * (account_id, plugin_event_id, sub_index) DO NOTHING (D-16; sub_index is NOT NULL, DB-2). RETURNING
 * lists only the rows this payload inserted; the rest were duplicates (resends, PLUGIN-10).
 */
async function insertEvents(
  tx: Tx,
  accountId: number,
  input: StoreInput,
  special: boolean,
): Promise<{ inserted: { seq: number; type: string }[]; duplicates: number }> {
  const rows = input.normalized.events.map((e) =>
    eventRow(e, accountId, input.device.id, input.recv, special),
  );
  const inserted: { seq: number; type: string }[] = [];
  for (let i = 0; i < rows.length; i += EVENT_INSERT_CHUNK) {
    const chunk = await tx
      .insert(events)
      .values(rows.slice(i, i + EVENT_INSERT_CHUNK))
      .onConflictDoNothing({ target: [events.accountId, events.pluginEventId, events.subIndex] })
      .returning({ seq: events.seq, type: events.type });
    inserted.push(...chunk);
  }
  return { inserted, duplicates: rows.length - inserted.length };
}

function eventRow(
  e: NormalizedEvent,
  accountId: number,
  deviceId: string,
  recv: Date,
  special: boolean,
): typeof events.$inferInsert {
  return {
    pluginEventId: e.pluginEventId,
    subIndex: e.subIndex,
    accountId,
    deviceId,
    type: e.type,
    occurredAt: e.occurredAt,
    receivedAt: recv,
    valueGp: e.valueGp,
    itemId: e.itemId,
    npcId: e.npcId,
    skill: e.skill,
    level: e.level,
    tier: e.tier,
    points: e.points,
    specialWorld: special,
    data: stripNul(e.data),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

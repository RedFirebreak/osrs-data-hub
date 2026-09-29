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
  normalizeName,
  payloadTime,
  planSnapshot,
  stripNul,
  type ItemData,
  type LatestStatePatch,
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
  wealthDaily,
  xpSamples,
  pgErrorCode,
  type Db,
  type Tx,
} from '@hub/db';
import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import { notifyEvents, notifyState } from '../notify';
import type { IngestDevice } from './device';
import type { AccountRef } from './identity';

/** First key of the per-account advisory lock: 'OS'. The second is the account id (both int4). */
export const ACCOUNT_LOCK_CLASS = 0x4f53;
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

/** A name-only payload whose account disappeared between lookup and transaction. */
export class AccountNotFoundError extends Error {
  constructor() {
    super('account not found');
    this.name = 'AccountNotFoundError';
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
 * Stores one payload for one account, in one transaction (retried on a deadlock or a racing unique
 * violation, see RETRYABLE_CODES; `onRetry` is told each time). Order (handoff §7.1): resolve the
 * account, take the per-account advisory lock, link the user (a blocked link rolls everything back:
 * "store nothing"), device bookkeeping, plan the snapshot against latest_state, then presence and
 * latest_state, XP samples, equipment/location/wealth, play sessions, the account row (last seen,
 * owner, name), and the events LAST so the transaction holds its event seqs as briefly as possible
 * (DB-4). Other database errors are thrown unchanged; the caller maps them to status codes.
 */
export async function storePayload(
  db: Db,
  input: StoreInput,
  onRetry?: (info: { attempt: number; pgCode: string }) => void,
): Promise<StoreOutcome> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await db.transaction((tx) => storeInTransaction(tx, input));
    } catch (err) {
      if (err instanceof BlockedContributor) return { kind: 'blocked', accountId: err.accountId };
      const pgCode = pgErrorCode(err);
      if (attempt >= MAX_ATTEMPTS || pgCode === undefined || !RETRYABLE_CODES.has(pgCode)) {
        throw err;
      }
      onRetry?.({ attempt, pgCode });
      await sleep(10 + Math.random() * 40);
    }
  }
}

async function storeInTransaction(tx: Tx, input: StoreInput): Promise<StoreOutcome> {
  const { recv, device, payload, normalized } = input;
  const player: PlayerSnapshot = payload.player ?? {};

  await setLocalTimeouts(tx);
  const account = await resolveAccount(tx, input.account, player, recv);
  await lockAccount(tx, account.id);
  await linkUser(tx, account.id, device.userId, recv);
  await touchDeviceAccount(tx, device.id, account.id, recv);
  const firstDataForDevice = await touchDeviceWithData(tx, input);

  const prev = await loadPrevState(tx, account.id);
  const plan = planSnapshot(prev, payload, {
    recv,
    deviceId: device.id,
    payloadTs: payloadTime(payload.timestamp, recv),
  });

  await upsertLatestState(tx, account.id, input, plan);
  await writeXpSamples(tx, account.id, recv, plan, input.skillIds);
  await writeDerived(tx, account.id, recv, plan);
  await updateSession(tx, account.id, device.id, recv, plan, normalized.shutdown);
  await updateAccount(tx, account.id, device.userId, recv, appliesSnapshot(plan) ? player : {});
  const { inserted, duplicates } = await insertEvents(tx, account.id, input, plan.special);

  if (inserted.length > 0) {
    await notifyEvents(tx, { accountId: account.id, seqs: inserted.map((r) => r.seq) });
  }
  await notifyState(tx, { accountId: account.id, deviceId: device.id, firstDataForDevice });

  return {
    kind: 'stored',
    accountId: account.id,
    newAccount: account.inserted,
    stale: plan.stale,
    special: plan.special,
    xpGuardSkill: plan.xpGuardTripped ? plan.xpGuardSkill : null,
    inserted,
    duplicates,
  };
}

/** Transaction-local timeouts; set_config because SET takes no bind parameters (DB-11). */
async function setLocalTimeouts(tx: Tx): Promise<void> {
  await tx.execute(
    sql`SELECT set_config('lock_timeout', ${LOCK_TIMEOUT}, true), set_config('statement_timeout', ${STATEMENT_TIMEOUT}, true)`,
  );
}

/** The resolved account and whether this transaction created it. */
interface ResolvedAccount {
  id: number;
  inserted: boolean;
}

/**
 * Finds the account with a plain SELECT and only INSERTs a new one. Writing osrs_accounts early (an
 * upsert on every payload) would hold its RowExclusiveLock for the whole transaction, and creating a
 * new xp_samples/location_samples chunk needs a ShareRowExclusiveLock on osrs_accounts (the FK
 * target): two concurrent payloads at a chunk boundary would deadlock. The row's own update (last
 * seen, owner, name) therefore happens late, in updateAccount.
 */
async function resolveAccount(
  tx: Tx,
  ref: AccountRef,
  player: PlayerSnapshot,
  recv: Date,
): Promise<ResolvedAccount> {
  const where =
    ref.kind === 'id'
      ? eq(osrsAccounts.id, ref.accountId)
      : eq(osrsAccounts.accountHash, ref.accountHash);
  const [found] = await tx.select({ id: osrsAccounts.id }).from(osrsAccounts).where(where);
  if (found) return { id: found.id, inserted: false };
  if (ref.kind === 'id') throw new AccountNotFoundError();
  const account = await insertAccount(tx, ref.accountHash, player, recv);
  if (account.inserted && player.name !== undefined) {
    await touchAccountName(tx, account.id, player.name, recv);
  }
  return account;
}

/**
 * INSERT … ON CONFLICT (account_hash) DO UPDATE … RETURNING: returns the row to BOTH of two
 * concurrent first payloads, where DO NOTHING would return nothing to the loser and a plain INSERT
 * would fail it with 23505 (DB-9). `xmax = 0` tells whether this statement inserted it.
 * A new account without a name gets the placeholder "Unknown" with an EMPTY name_normalized, so a
 * name-only lookup can never match the placeholder.
 */
async function insertAccount(
  tx: Tx,
  accountHash: string,
  player: PlayerSnapshot,
  recv: Date,
): Promise<ResolvedAccount> {
  const [row] = await tx
    .insert(osrsAccounts)
    .values({
      publicId: generatePublicId(),
      accountHash,
      currentName: player.name ?? UNKNOWN_NAME,
      nameNormalized: player.name === undefined ? '' : normalizeName(player.name),
      accountType: player.accountType ?? null,
      firstSeen: recv,
      lastSeen: recv,
    })
    .onConflictDoUpdate({
      target: osrsAccounts.accountHash,
      set: { lastSeen: sql`GREATEST(${osrsAccounts.lastSeen}, excluded.last_seen)` },
    })
    .returning({ id: osrsAccounts.id, inserted: sql<boolean>`(xmax = 0)` });
  if (!row) throw new Error('account upsert returned no row');
  return row;
}

/**
 * Serializes all ingest work per account until commit. lock_timeout bounds the wait (55P03 → 503).
 * Both keys are int4 so the lock shares the (int4, int4) space with pg_advisory_lock(0x4f53, id).
 */
async function lockAccount(tx: Tx, accountId: number): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(${ACCOUNT_LOCK_CLASS}::int4, ${accountId}::int4)`,
  );
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
 * The account row, written once and late (see resolveAccount): last_seen, an unclaimed account
 * becomes this user's (first reporter is owner, D-21; COALESCE makes a concurrent claim safe) with
 * the link's role following, and — from an applied snapshot only (`identity` is empty otherwise) —
 * a rename (D-15: history is keyed by the id, so nothing else changes) or a new account type.
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
    .returning({ ownerUserId: osrsAccounts.ownerUserId });
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
 * The row is locked first, so two concurrent first payloads can't both report "first".
 */
async function touchDeviceWithData(tx: Tx, input: StoreInput): Promise<boolean> {
  const [before] = await tx
    .select({ firstDataAt: devices.firstDataAt })
    .from(devices)
    .where(eq(devices.id, input.device.id))
    .for('update');
  const first = before !== undefined && before.firstDataAt === null;
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
    })
    .from(latestState)
    .where(eq(latestState.accountId, accountId));
  if (!row) return null;
  return {
    ...row,
    // Written by this module from validated sections; the shape checks only guard against edits.
    skills: isPlainObject(row.skills) ? (row.skills as PrevState['skills']) : null,
    equipment: Array.isArray(row.equipment) ? (row.equipment as ItemData[]) : null,
  };
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
 * snapshot is stale (D-33), tick_delay when known (> 0), plus the plan's patch. Only the patch's keys
 * are written, so a section missing from the payload keeps its value and its *_updated_at (D-18).
 */
async function upsertLatestState(
  tx: Tx,
  accountId: number,
  input: StoreInput,
  plan: SnapshotPlan,
): Promise<void> {
  const { payload, recv } = input;
  const presence: Partial<typeof latestState.$inferInsert> = { lastDeviceId: input.device.id };
  if (payload.state !== null && !plan.stale) presence.gameState = payload.state;
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

/** Equipment change log, the 1-minute location sample and the day's carried wealth. */
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
  if (plan.locationSample !== null) {
    await tx
      .insert(locationSamples)
      .values({ accountId, ...plan.locationSample })
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

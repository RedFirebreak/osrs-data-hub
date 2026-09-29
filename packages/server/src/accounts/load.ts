/**
 * Shared loaders for the read models: accounts together with the viewer's resolved access, presence,
 * and recent events. Every read model starts here, so every one of them goes through the one
 * permission resolver (@hub/core resolveAccess, D-22) before touching data.
 */
import {
  isOnline,
  resolveAccess,
  type AccountAccess,
  type ResolvedAccess,
  type Viewer,
} from '@hub/core';
import { latestState, osrsAccounts, type AccountStatus, type DbOrTx } from '@hub/db';
import { eq, inArray, sql, type SQL } from 'drizzle-orm';
import { toFeedEvent, type EventRowLike, type FeedEvent } from '../feed';
import { loadAccountAccess } from './access';

/** Public ids are 12 base62 characters (D-46); anything longer can't match and isn't queried. */
const MAX_PUBLIC_ID_LENGTH = 64;

export interface AccountRow {
  id: number;
  publicId: string;
  name: string;
  accountType: number | null;
  ownerUserId: string | null;
  status: AccountStatus;
  firstSeen: Date;
  lastSeen: Date;
}

export interface AccountWithAccess {
  account: AccountRow;
  /** The resolver's input (owner, links, sharing, grants). */
  raw: AccountAccess;
  /** What this viewer may see and do. */
  access: ResolvedAccess;
}

const accountColumns = {
  id: osrsAccounts.id,
  publicId: osrsAccounts.publicId,
  name: osrsAccounts.currentName,
  accountType: osrsAccounts.accountType,
  ownerUserId: osrsAccounts.ownerUserId,
  status: osrsAccounts.status,
  firstSeen: osrsAccounts.firstSeen,
  lastSeen: osrsAccounts.lastSeen,
};

/**
 * The account with this public id and the viewer's access to it; null when it doesn't exist or the
 * viewer may not know it exists (resolveAccess visible false: hidden accounts for non-admins, inactive
 * viewers, nothing shared with them). Callers answer null with a 404, so existence never leaks.
 */
export async function loadVisibleAccount(
  db: DbOrTx,
  viewer: Viewer,
  publicId: string,
): Promise<AccountWithAccess | null> {
  if (typeof publicId !== 'string' || publicId.length > MAX_PUBLIC_ID_LENGTH) return null;
  const [found] = await loadAccountsWithAccess(db, viewer, eq(osrsAccounts.publicId, publicId));
  return found ?? null;
}

/**
 * Every account the viewer may know exists, with its access. An inactive viewer sees nothing, so no
 * query runs. Hidden accounts are filtered in SQL for non-admins (the resolver would drop them too).
 */
export async function loadVisibleAccounts(
  db: DbOrTx,
  viewer: Viewer,
): Promise<AccountWithAccess[]> {
  if (viewer.status !== 'active') return [];
  const scope = viewer.isAdmin === true ? undefined : eq(osrsAccounts.status, 'active');
  return loadAccountsWithAccess(db, viewer, scope);
}

async function loadAccountsWithAccess(
  db: DbOrTx,
  viewer: Viewer,
  where: SQL | undefined,
): Promise<AccountWithAccess[]> {
  if (viewer.status !== 'active') return [];
  const rows = await db.select(accountColumns).from(osrsAccounts).where(where);
  if (rows.length === 0) return [];
  const raws = await loadAccountAccess(
    db,
    rows.map((r) => r.id),
  );
  const out: AccountWithAccess[] = [];
  for (const account of rows) {
    const raw = raws.get(account.id);
    if (!raw) continue; // deleted between the two queries
    const access = resolveAccess(viewer, raw);
    if (access.visible) out.push({ account, raw, access });
  }
  return out;
}

/** The presence columns of latest_state. */
export interface PresenceRow {
  accountId: number;
  lastSeen: Date;
  gameState: string | null;
  tickDelay: number | null;
  world: number | null;
  specialWorld: boolean;
}

export interface Presence {
  online: boolean;
  /** Last known world (also while offline; the UI shows it next to the online dot). */
  world: number | null;
  /** The last known world is a special one (league, DMM…, handoff §7.1.9). */
  specialWorld: boolean;
  gameState: string | null;
  lastSeen: string | null;
}

/** Presence rows by account id (accounts that never sent a payload have none). */
export async function loadPresence(
  db: DbOrTx,
  accountIds: readonly number[],
): Promise<Map<number, PresenceRow>> {
  const out = new Map<number, PresenceRow>();
  if (accountIds.length === 0) return out;
  const rows = await db
    .select({
      accountId: latestState.accountId,
      lastSeen: latestState.lastSeen,
      gameState: latestState.gameState,
      tickDelay: latestState.tickDelay,
      world: latestState.world,
      specialWorld: latestState.specialWorld,
    })
    .from(latestState)
    .where(inArray(latestState.accountId, [...accountIds]));
  for (const row of rows) out.set(row.accountId, row);
  return out;
}

/** Presence as the UI shows it: online per @hub/core isOnline (D-28). */
export function toPresence(row: PresenceRow, now: Date): Presence {
  return {
    online: isOnline(row, now),
    world: row.world,
    specialWorld: row.specialWorld,
    gameState: row.gameState,
    lastSeen: row.lastSeen.toISOString(),
  };
}

/**
 * The newest `perAccount` events of each account, newest first by seq (the feed's order, so the UI's
 * "load more" can continue with listFeed({ beforeSeq })), as raw rows. One LATERAL query, so each
 * account's scan stops after `perAccount` rows. Callers redact through toFeedEvent.
 */
export async function loadRecentEventRows(
  db: DbOrTx,
  accountIds: readonly number[],
  perAccount: number,
): Promise<Map<number, EventRowLike[]>> {
  const out = new Map<number, EventRowLike[]>();
  if (accountIds.length === 0 || perAccount <= 0) return out;
  const result = await db.execute<RawEventRow>(sql`
    SELECT e.account_id, e.id, e.seq, e.type, e.occurred_at, e.received_at, e.value_gp, e.item_id,
           e.npc_id, e.skill, e.level, e.tier, e.points, e.special_world, e.data
    FROM unnest(${sql.param([...accountIds])}::int[]) AS a(id)
    CROSS JOIN LATERAL (
      SELECT * FROM events ev WHERE ev.account_id = a.id ORDER BY ev.seq DESC LIMIT ${perAccount}
    ) e
    ORDER BY e.seq DESC`);
  for (const r of result.rows) {
    const list = out.get(r.account_id) ?? [];
    list.push(fromRawEventRow(r));
    out.set(r.account_id, list);
  }
  return out;
}

/** An events row as `db.execute` returns it (snake_case; int8 parsed to number by @hub/db). */
interface RawEventRow extends Record<string, unknown> {
  account_id: number;
  id: string;
  seq: number;
  type: string;
  occurred_at: Date;
  received_at: Date;
  value_gp: number | null;
  item_id: number | null;
  npc_id: number | null;
  skill: string | null;
  level: number | null;
  tier: string | null;
  points: number | null;
  special_world: boolean;
  data: unknown;
}

function fromRawEventRow(r: RawEventRow): EventRowLike {
  return {
    id: r.id,
    seq: Number(r.seq),
    type: r.type,
    occurredAt: new Date(r.occurred_at),
    receivedAt: new Date(r.received_at),
    valueGp: r.value_gp === null ? null : Number(r.value_gp),
    itemId: r.item_id,
    npcId: r.npc_id,
    skill: r.skill,
    level: r.level,
    tier: r.tier,
    points: r.points,
    specialWorld: r.special_world,
    data: r.data,
  };
}

/** Rows → FeedEvents for one account, redacted for the viewer's categories. */
export function toFeedEvents(rows: readonly EventRowLike[], entry: AccountWithAccess): FeedEvent[] {
  const ref = { publicId: entry.account.publicId, name: entry.account.name };
  return rows.map((row) => toFeedEvent(row, ref, entry.access.categories));
}

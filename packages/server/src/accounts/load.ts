/**
 * Shared loaders for the read models: accounts together with the viewer's resolved access, presence,
 * and recent events. Every read model starts here, so every one of them goes through the one
 * permission resolver (@hub/core resolveAccess, D-22) before touching data.
 */
import {
  isOnline,
  resolveAccess,
  type AccountAccess,
  type Category,
  type ResolvedAccess,
  type Viewer,
} from '@hub/core';
import { latestState, osrsAccounts, type AccountStatus, type DbOrTx } from '@hub/db';
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
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

/**
 * Narrows what a viewer may see further, on top of resolveAccess: the public API's key (D-70). A
 * restricted viewer sees an account only when it is in `accountIds` (null = no account limit) AND
 * resolveAccess grants at least one category that is also in `categories`; its categories are that
 * intersection. A restricted load never applies the admin override (the viewer is treated as a
 * non-admin) and never grants `canManage`: API keys read, they don't manage.
 */
export interface AccessRestriction {
  categories: ReadonlySet<Category>;
  /** Internal account ids; null = every account the viewer may see. */
  accountIds: ReadonlySet<number> | null;
}

/**
 * `access` narrowed by `restrict` (see AccessRestriction): categories intersected, visible only with
 * at least one category left, never canManage. Pure; the loaders below apply it after resolveAccess.
 */
export function restrictAccess(
  access: ResolvedAccess,
  restrict: AccessRestriction,
): ResolvedAccess {
  const categories = new Set<Category>();
  for (const c of access.categories) if (restrict.categories.has(c)) categories.add(c);
  return {
    visible: access.visible && categories.size > 0,
    categories,
    relation: access.relation,
    canManage: false,
  };
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
 * With `restrict` (the public API, D-70), also null when the account is outside its scope or none of
 * its categories is granted; `access` is then the narrowed one (see AccessRestriction).
 */
export async function loadVisibleAccount(
  db: DbOrTx,
  viewer: Viewer,
  publicId: string,
  restrict?: AccessRestriction,
): Promise<AccountWithAccess | null> {
  if (typeof publicId !== 'string' || publicId.length > MAX_PUBLIC_ID_LENGTH) return null;
  const [found] = await loadAccountsWithAccess(
    db,
    viewer,
    eq(osrsAccounts.publicId, publicId),
    restrict,
  );
  return found ?? null;
}

/**
 * Every account the viewer may know exists, with its access. An inactive viewer sees nothing, so no
 * query runs. Hidden accounts are filtered in SQL for non-admins (the resolver would drop them too).
 * With `restrict`, only the accounts it allows, with the narrowed access (see AccessRestriction); an
 * account list is applied in SQL.
 */
export async function loadVisibleAccounts(
  db: DbOrTx,
  viewer: Viewer,
  restrict?: AccessRestriction,
): Promise<AccountWithAccess[]> {
  if (viewer.status !== 'active') return [];
  const admin = viewer.isAdmin === true && restrict === undefined;
  const scope = admin ? undefined : eq(osrsAccounts.status, 'active');
  return loadAccountsWithAccess(db, viewer, scope, restrict);
}

async function loadAccountsWithAccess(
  db: DbOrTx,
  viewer: Viewer,
  where: SQL | undefined,
  restrict?: AccessRestriction,
): Promise<AccountWithAccess[]> {
  if (viewer.status !== 'active') return [];
  // The admin override never applies through a restriction (D-70).
  const effective: Viewer = restrict ? { ...viewer, isAdmin: false } : viewer;
  let filter = where;
  if (restrict?.accountIds) {
    if (restrict.accountIds.size === 0) return [];
    filter = and(where, inArray(osrsAccounts.id, [...restrict.accountIds]));
  }
  const rows = await db.select(accountColumns).from(osrsAccounts).where(filter);
  if (rows.length === 0) return [];
  const raws = await loadAccountAccess(
    db,
    rows.map((r) => r.id),
  );
  const out: AccountWithAccess[] = [];
  for (const account of rows) {
    const raw = raws.get(account.id);
    if (!raw) continue; // deleted between the two queries
    const resolved = resolveAccess(effective, raw);
    const access = restrict ? restrictAccess(resolved, restrict) : resolved;
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

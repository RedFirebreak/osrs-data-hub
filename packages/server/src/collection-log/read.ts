/**
 * The collection log slots the hub has seen (D-118): the plugin's `collectionLog` events, one per new
 * slot, with the kill count the plugin read from the chat line before it. The hub only knows slots
 * logged since the account was paired; the hiscores' "Collections Logged" is the whole log's count.
 *
 * Where a slot came from is not in the event. It is the source of the loot drop that came within 10
 * seconds of it (the boss page's rule for uniques, D-108), or null when there was none (a pet, a
 * reward from a minigame shop, a drop the plugin didn't report as loot).
 */
import type { DbOrTx } from '@hub/db';
import { sql } from 'drizzle-orm';

/** Item names longer than this are cut (the plugin sends the popup's text as it is). */
const MAX_ITEM_LENGTH = 100;
/** Source names longer than this are cut. */
const MAX_SOURCE_LENGTH = 64;
/** At most this many entries per account are read: more than the whole in-game log has slots. */
export const MAX_SLOTS_PER_ACCOUNT = 2_500;

export interface CollectionLogSlot {
  /** The item's id; null when the plugin couldn't resolve the popup's name (sent as -1). */
  itemId: number | null;
  item: string;
  /** The kill count the plugin attached; null when there was none. */
  killCount: number | null;
  /** The GE value the plugin sent; 0 for untradeables. */
  value: number | null;
  /** When it was logged (ISO). */
  at: string;
  /** The loot source within 10 seconds of it ("Zulrah"), or null. */
  source: string | null;
}

type SlotRow = {
  account_id: number;
  occurred_at: Date;
  item_id: number | null;
  value_gp: number | string | null;
  item: string | null;
  kc: string | null;
  source: string | null;
};

/**
 * The slots of each account, newest first. A slot sent twice (the same item name again, which the
 * game never does but a reinstalled plugin might) is listed once, at the first time it was logged.
 * Leagues, Deadman and other special worlds keep a log of their own, so their entries are left out.
 * `itemLike` keeps only items whose name contains it (case-insensitive), for the guild lookup.
 */
export async function readSlots(
  db: DbOrTx,
  accountIds: readonly number[],
  opts: { itemLike?: string } = {},
): Promise<Map<number, CollectionLogSlot[]>> {
  const out = new Map<number, CollectionLogSlot[]>();
  const ids = [...new Set(accountIds)];
  if (ids.length === 0) return out;
  const like =
    opts.itemLike === undefined
      ? sql`true`
      : sql`c.data #>> '{data,itemName}' ILIKE ${`%${escapeLike(opts.itemLike)}%`}`;
  const result = await db.execute<SlotRow>(sql`
    SELECT s.account_id, s.occurred_at, s.item_id, s.value_gp, s.item, s.kc, l.source
    FROM (
      SELECT c.account_id, c.occurred_at, c.item_id, c.value_gp,
             c.data #>> '{data,itemName}' AS item, c.data #>> '{data,killCount}' AS kc,
             row_number() OVER (PARTITION BY c.account_id ORDER BY c.occurred_at DESC) AS n
      FROM events c
      WHERE c.account_id = ANY(${sql.param(ids)}::int[]) AND c.type = 'collection_log'
        AND NOT c.special_world AND ${like}
    ) s
    LEFT JOIN LATERAL (
      SELECT ev.data #>> '{data,source,text}' AS source FROM events ev
      WHERE ev.account_id = s.account_id AND ev.type = 'loot'
        AND ev.occurred_at BETWEEN s.occurred_at - interval '10 seconds'
                               AND s.occurred_at + interval '10 seconds'
      ORDER BY abs(extract(epoch FROM ev.occurred_at - s.occurred_at))
      LIMIT 1
    ) l ON true
    WHERE s.n <= ${MAX_SLOTS_PER_ACCOUNT}
    ORDER BY s.account_id, s.occurred_at ASC`);
  const seen = new Map<number, Set<string>>();
  for (const r of result.rows) {
    const item = cleanText(r.item, MAX_ITEM_LENGTH);
    if (item === null) continue;
    const names = seen.get(r.account_id) ?? new Set<string>();
    seen.set(r.account_id, names);
    const key = item.toLowerCase();
    if (names.has(key)) continue;
    names.add(key);
    const list = out.get(r.account_id) ?? [];
    out.set(r.account_id, list);
    list.push({
      itemId: r.item_id,
      item,
      killCount: r.kc !== null && /^\d{1,9}$/.test(r.kc) ? Number(r.kc) : null,
      value: r.value_gp === null ? null : Number(r.value_gp),
      at: new Date(r.occurred_at).toISOString(),
      source: cleanText(r.source, MAX_SOURCE_LENGTH),
    });
  }
  for (const list of out.values()) list.reverse();
  return out;
}

/** A trimmed, cut string, or null when there is nothing left. */
function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim().slice(0, max);
  return text === '' ? null : text;
}

/** `%`, `_` and `\` taken literally in an ILIKE pattern. */
function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

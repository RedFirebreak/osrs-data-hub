/**
 * The settled-cursor rule (DB-4): `events.seq` is taken at INSERT, not at commit, so a lower seq can
 * become visible after a higher one. A cursor feed therefore serves only the seqs below the first row
 * that is still young. Both cursor feeds build their window from these two fragments: the live
 * stream's replay and polling fallback (live/replay.ts) and the public API's /events (api/events.ts).
 */
import { events } from '@hub/db';
import { sql, type SQL } from 'drizzle-orm';

/**
 * The highest seq received at or before `before` (0 when none), so the window is an index range on
 * seq even when the client's cursor is 0 or far behind: `received_at` has no index, and without this
 * bound every poll would scan the whole events table. Found by walking the seq index backwards from
 * the newest row, which reads only the rows of the last few minutes. Evaluated once per query
 * (an InitPlan).
 */
export function seqFloor(before: Date): SQL {
  return sql`coalesce((select ${events.seq} from ${events} where ${events.receivedAt} <= ${before} order by ${events.seq} desc limit 1), 0)`;
}

/**
 * The lowest seq above the cursor inserted less than `settleMs` ago (database clock: inserted_at is
 * clock_timestamp() at insert), or "no limit". Serving only seqs BELOW it, rather than skipping each
 * young row on its own, keeps the result a gap-free prefix: inserted_at order can differ from seq
 * order (a backend descheduled between taking its seq and its timestamp, or the database clock
 * stepping back), and a settled row above a young one would move the cursor past it (DB-4). The
 * walk up the seq index starts at the window's floor, so it reads only the last few minutes. `floor`
 * must be at or below every seq that can still be young (seqFloor of a time well before the margin).
 */
export function settledCeiling(afterSeq: number, floor: SQL, settleMs: number): SQL {
  return sql`coalesce((select min(${events.seq}) from ${events} where ${events.seq} > ${afterSeq} and ${events.seq} > ${floor} and ${events.insertedAt} > clock_timestamp() - make_interval(secs => ${settleMs / 1000})), ${Number.MAX_SAFE_INTEGER})`;
}

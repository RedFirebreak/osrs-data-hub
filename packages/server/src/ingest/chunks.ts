/**
 * Serializes hypertable chunk creation among ingest transactions (TSDB-12, D-58).
 *
 * The first row in a new chunk of xp_samples or location_samples makes TimescaleDB add the chunk's
 * foreign key to osrs_accounts, which takes a ShareRowExclusiveLock on osrs_accounts and keeps it until
 * commit, while holding the hypertable's chunk-creation lock. Two transactions that create chunks of
 * the two hypertables in different orders (a new account writes XP and then a location sample, an
 * existing one only a location sample) wait for each other: 40P01, observed at every chunk boundary
 * with a handful of concurrent payloads. So a transaction that may create a chunk first takes one
 * advisory lock shared by all of them, and only one creates chunks at a time.
 *
 * "May create" is judged from an in-process record of the chunk ranges this process has already
 * written to and committed: the lock is taken only for the first payloads of a new day (location) or
 * week (XP), and after a restart. A wrong guess costs nothing worse than before: the in-process retry.
 */
import { XP_BUCKET_MS, floorTo, type SnapshotPlan } from '@hub/core';
import type { Db, Tx } from '@hub/db';
import { sql } from 'drizzle-orm';

const DAY_MS = 86_400_000;
/** chunk_time_interval of the hypertables ingest writes (packages/db/drizzle/0001_timescale.sql). */
const CHUNK_INTERVAL_MS = { xp_samples: 7 * DAY_MS, location_samples: DAY_MS } as const;
/** Advisory lock (CHUNK_LOCK_CLASS, 0) of a transaction that may create a chunk: 'OC'. */
const CHUNK_LOCK_CLASS = 0x4f43;
/** Ranges remembered per database handle; far more than a year of days and weeks. */
const MAX_KNOWN_CHUNKS = 1_000;

// On globalThis like every process-wide cache (NEXT-3); keyed by the Db handle so test databases
// in one process don't share their records.
const g = globalThis as unknown as { __hubIngestKnownChunks?: WeakMap<object, Set<string>> };

/**
 * The chunk ranges this plan writes to, as `<hypertable>:<range index>`. Chunks are aligned to
 * multiples of their interval since the epoch, so the index identifies the chunk.
 */
export function chunkKeys(plan: SnapshotPlan, recv: Date): string[] {
  const keys: string[] = [];
  if (plan.locationSample !== null) {
    keys.push(chunkKey('location_samples', plan.locationSample.ts));
  }
  if (plan.xpWrites.length > 0) {
    keys.push(chunkKey('xp_samples', floorTo(recv, XP_BUCKET_MS)));
  }
  return keys;
}

function chunkKey(table: keyof typeof CHUNK_INTERVAL_MS, at: Date): string {
  return `${table}:${Math.floor(at.getTime() / CHUNK_INTERVAL_MS[table])}`;
}

/** The ranges known to have a committed chunk, for this database handle. */
export function knownChunks(db: Db): Set<string> {
  g.__hubIngestKnownChunks ??= new WeakMap();
  let known = g.__hubIngestKnownChunks.get(db);
  if (!known) {
    known = new Set();
    g.__hubIngestKnownChunks.set(db, known);
  }
  return known;
}

/**
 * Takes the chunk-creation lock (until commit) when any of `keys` isn't known yet. Call it before the
 * transaction's first hypertable write; record the keys with rememberChunks after the commit.
 */
export async function lockChunkCreation(
  tx: Tx,
  known: ReadonlySet<string>,
  keys: readonly string[],
): Promise<void> {
  if (keys.every((k) => known.has(k))) return;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${CHUNK_LOCK_CLASS}::int4, 0)`);
}

/** Records committed writes: their chunks exist from now on. */
export function rememberChunks(known: Set<string>, keys: readonly string[]): void {
  if (known.size + keys.length > MAX_KNOWN_CHUNKS) known.clear();
  for (const k of keys) known.add(k);
}

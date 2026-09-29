/**
 * skills.name → skills.id. The table grows when the plugin sends a skill name the hub hasn't seen
 * ("don't hardcode the list", handoff §3.3), so names are resolved at ingest time and cached per
 * database on globalThis (D-37: route handlers may run in several module instances).
 */
import { skills, type Db } from '@hub/db';
import { inArray } from 'drizzle-orm';

/** sort_order for skills first seen at ingest: after the seeded ones, in insertion order. */
const NEW_SKILL_SORT_ORDER = 1000;

const g = globalThis as unknown as { __hubSkillIds?: WeakMap<Db, Map<string, number>> };

function cacheFor(db: Db): Map<string, number> {
  g.__hubSkillIds ??= new WeakMap();
  let cache = g.__hubSkillIds.get(db);
  if (!cache) {
    cache = new Map();
    g.__hubSkillIds.set(db, cache);
  }
  return cache;
}

/**
 * Ids for `names`, inserting unknown ones (kind 'plugin', sort_order 1000). Runs on `db` outside the
 * ingest transaction and before it, so a new name is committed at once: the cache never holds an id
 * that a rolled-back transaction invented, and concurrent payloads don't wait on each other's insert.
 * `ON CONFLICT DO NOTHING` + a SELECT also resolves a name another process inserted meanwhile (DB-9).
 * With a warm cache this makes no query at all.
 */
export async function resolveSkillIds(
  db: Db,
  names: readonly string[],
): Promise<ReadonlyMap<string, number>> {
  const cache = cacheFor(db);
  if (names.some((n) => !cache.has(n)) && cache.size === 0) {
    await remember(cache, db.select({ id: skills.id, name: skills.name }).from(skills));
  }
  const missing = [...new Set(names.filter((n) => !cache.has(n)))];
  if (missing.length > 0) {
    await db
      .insert(skills)
      .values(
        missing.map((name) => ({ name, kind: 'plugin' as const, sortOrder: NEW_SKILL_SORT_ORDER })),
      )
      .onConflictDoNothing({ target: skills.name });
    await remember(
      cache,
      db
        .select({ id: skills.id, name: skills.name })
        .from(skills)
        .where(inArray(skills.name, missing)),
    );
  }
  const ids = new Map<string, number>();
  for (const name of names) {
    const id = cache.get(name);
    if (id === undefined) throw new Error('skill id not resolved');
    ids.set(name, id);
  }
  return ids;
}

async function remember(
  cache: Map<string, number>,
  rows: PromiseLike<{ id: number; name: string }[]>,
): Promise<void> {
  for (const { id, name } of await rows) cache.set(name, id);
}

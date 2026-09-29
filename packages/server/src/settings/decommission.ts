/**
 * The decommission switch (handoff §3.2, §12 Admin, D-19): while on, ingest answers 410 and every
 * plugin disables its connection for good. Stored in hub_settings under 'decommissioned'.
 */
import { hubSettings, type Db, type DbOrTx } from '@hub/db';
import { eq, sql } from 'drizzle-orm';
import { audit } from '../audit';

const DECOMMISSIONED_KEY = 'decommissioned';
/** Ingest reads the switch on every payload; 10 s of staleness is fine for a one-way switch. */
const CACHE_TTL_MS = 10_000;

// On globalThis like every process-wide cache: route handlers and RSC are separate module instances,
// and the admin page's setDecommissioned must clear the cache ingest reads (NEXT-3, D-37).
const g = globalThis as unknown as {
  __hubDecommissioned?: { value: boolean; expiresAt: number };
};

/**
 * Whether the hub is decommissioned (hub_settings 'decommissioned' is JSON `true`; anything else,
 * or no row, is false). Cached for 10 s per process; setDecommissioned clears the cache.
 */
export async function isDecommissioned(db: DbOrTx): Promise<boolean> {
  const cached = g.__hubDecommissioned;
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.value;
  // Compared in SQL: drizzle's jsonb reader JSON.parses string values a second time, so a stored
  // string "true" would come back as the boolean true.
  const [row] = await db
    .select({ on: sql<boolean>`${hubSettings.value} = 'true'::jsonb` })
    .from(hubSettings)
    .where(eq(hubSettings.key, DECOMMISSIONED_KEY));
  const value = row?.on === true;
  g.__hubDecommissioned = { value, expiresAt: now + CACHE_TTL_MS };
  return value;
}

/** Forgets the cached switch, so the next isDecommissioned reads the database. */
export function clearDecommissionedCache(): void {
  delete g.__hubDecommissioned;
}

/**
 * Turns the switch on or off (admin only; the caller checks). Audited as 'hub.decommissioned' with
 * the new value, and clears this process's cache so ingest in this process sees it at once (other
 * processes within 10 s).
 */
export async function setDecommissioned(
  db: Db,
  opts: { value: boolean; actorUserId: string },
): Promise<void> {
  await db.transaction(async (tx) => {
    const now = new Date();
    await tx
      .insert(hubSettings)
      .values({
        key: DECOMMISSIONED_KEY,
        value: opts.value,
        updatedAt: now,
        updatedBy: opts.actorUserId,
      })
      .onConflictDoUpdate({
        target: hubSettings.key,
        set: { value: opts.value, updatedAt: now, updatedBy: opts.actorUserId },
      });
    await audit(tx, {
      actorUserId: opts.actorUserId,
      action: 'hub.decommissioned',
      targetType: 'hub',
      targetId: DECOMMISSIONED_KEY,
      meta: { value: opts.value },
    });
  });
  clearDecommissionedCache();
}

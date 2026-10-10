/**
 * The guild's "Online now" strip on Home (handoff §12): who the viewer may see playing right now.
 */
import type { Viewer } from '@hub/core';
import type { DbOrTx } from '@hub/db';
import { loadPresence, loadVisibleAccounts, toPresence } from './load';

export interface OnlineEntry {
  publicId: string;
  name: string;
  accountType: number | null;
  world: number | null;
  specialWorld: boolean;
  lastSeen: string;
}

/**
 * Every visible account whose activity the viewer may see and that is online at `now` (isOnline),
 * the viewer's own included, sorted by name. Hidden accounts only for admins; an inactive viewer
 * sees nobody.
 */
export async function getOnlineNow(
  db: DbOrTx,
  viewer: Viewer,
  opts: { now: Date },
): Promise<OnlineEntry[]> {
  const visible = await loadVisibleAccounts(db, viewer);
  const withActivity = visible.filter((e) => e.access.categories.has('activity'));
  const presence = await loadPresence(
    db,
    withActivity.map((e) => e.account.id),
  );
  const out: OnlineEntry[] = [];
  for (const { account } of withActivity) {
    const row = presence.get(account.id);
    if (!row || !toPresence(row, opts.now).online) continue;
    out.push({
      publicId: account.publicId,
      name: account.name,
      accountType: account.accountType,
      world: row.world,
      specialWorld: row.specialWorld,
      lastSeen: row.lastSeen.toISOString(),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
}

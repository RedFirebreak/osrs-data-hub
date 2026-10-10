/**
 * The viewer's own characters: what Home opens on, what the character pickers offer and what the
 * navigation counts as "yours".
 */
import type { Viewer } from '@hub/core';
import type { DbOrTx } from '@hub/db';
import { loadVisibleAccounts } from './load';

export interface OwnAccount {
  publicId: string;
  name: string;
  accountType: number | null;
}

/**
 * Every visible account the viewer owns or contributes to through a non-blocked link (the
 * dashboard's rule: hidden accounts only for admins), most recently seen first, so the first one is
 * the character the viewer played last. An inactive viewer has none.
 */
export async function listOwnAccounts(db: DbOrTx, viewer: Viewer): Promise<OwnAccount[]> {
  const visible = await loadVisibleAccounts(db, viewer);
  return visible
    .filter((e) => e.access.relation === 'owner' || e.access.relation === 'contributor')
    .sort((a, b) => b.account.lastSeen.getTime() - a.account.lastSeen.getTime())
    .map(({ account }) => ({
      publicId: account.publicId,
      name: account.name,
      accountType: account.accountType,
    }));
}

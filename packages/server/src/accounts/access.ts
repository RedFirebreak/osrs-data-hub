/**
 * Loads the inputs of the permission resolver (@hub/core resolveAccess) from the database. Shared by
 * the UI queries, the SSE fan-out and (M3) the API, so every surface applies the same rules.
 */
import {
  isCategory,
  type AccountAccess,
  type Audience,
  type Category,
  type Viewer,
} from '@hub/core';
import {
  accountLinks,
  accountShareGrants,
  accountSharing,
  osrsAccounts,
  users,
  type DbOrTx,
} from '@hub/db';
import { eq, inArray } from 'drizzle-orm';

/** The viewer as the resolver needs it; null when the user doesn't exist. */
export async function loadViewer(db: DbOrTx, userId: string): Promise<Viewer | null> {
  const [u] = await db
    .select({ id: users.id, status: users.status, isAdmin: users.isAdmin })
    .from(users)
    .where(eq(users.id, userId));
  return u ? { userId: u.id, status: u.status, isAdmin: u.isAdmin } : null;
}

/** AccountAccess for each requested account id (missing ids are absent from the map). */
export async function loadAccountAccess(
  db: DbOrTx,
  accountIds: readonly number[],
): Promise<Map<number, AccountAccess>> {
  const out = new Map<number, AccountAccess>();
  const ids = [...new Set(accountIds)];
  if (ids.length === 0) return out;
  // Sequential on purpose: callers pass transaction handles, and concurrent queries on one pg client
  // are deprecated (they stop working in pg 9, DB-14).
  const accounts = await db
    .select({
      id: osrsAccounts.id,
      status: osrsAccounts.status,
      ownerUserId: osrsAccounts.ownerUserId,
      hiddenFromGuild: osrsAccounts.hiddenFromGuild,
    })
    .from(osrsAccounts)
    .where(inArray(osrsAccounts.id, ids));
  const links = await db
    .select({
      accountId: accountLinks.accountId,
      userId: accountLinks.userId,
      role: accountLinks.role,
      blocked: accountLinks.blocked,
    })
    .from(accountLinks)
    .where(inArray(accountLinks.accountId, ids));
  const sharing = await db
    .select({
      accountId: accountSharing.accountId,
      category: accountSharing.category,
      audience: accountSharing.audience,
    })
    .from(accountSharing)
    .where(inArray(accountSharing.accountId, ids));
  const grants = await db
    .select({
      accountId: accountShareGrants.accountId,
      category: accountShareGrants.category,
      userId: accountShareGrants.granteeUserId,
    })
    .from(accountShareGrants)
    .where(inArray(accountShareGrants.accountId, ids));
  for (const a of accounts) {
    out.set(a.id, {
      status: a.status,
      ownerUserId: a.ownerUserId,
      links: [],
      sharing: {},
      grants: [],
      hiddenFromGuild: a.hiddenFromGuild,
    });
  }
  for (const l of links) {
    const acc = out.get(l.accountId);
    if (acc)
      (acc.links as AccountAccess['links'][number][]).push({
        userId: l.userId,
        role: l.role,
        blocked: l.blocked,
      });
  }
  for (const s of sharing) {
    const acc = out.get(s.accountId);
    if (acc && isCategory(s.category)) {
      (acc.sharing as Partial<Record<Category, Audience>>)[s.category] = s.audience;
    }
  }
  for (const gr of grants) {
    const acc = out.get(gr.accountId);
    if (acc && isCategory(gr.category)) {
      (acc.grants as AccountAccess['grants'][number][]).push({
        category: gr.category,
        userId: gr.userId,
      });
    }
  }
  return out;
}

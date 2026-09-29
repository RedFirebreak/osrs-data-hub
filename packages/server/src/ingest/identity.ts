/** Which OSRS account a payload belongs to (handoff §7.2, D-15, D-29). */
import { normalizeName, type PlayerSnapshot } from '@hub/core';
import { accountLinks, osrsAccounts, type Db } from '@hub/db';
import { and, eq } from 'drizzle-orm';

/** How the transaction finds the account: by hash (created when new) or an existing id. */
export type AccountRef = { kind: 'hash'; accountHash: string } | { kind: 'id'; accountId: number };

/**
 * What the payload says about identity:
 * - 'hash': player.accountHash (the key; always the case on v1.5 when logged in);
 * - 'name': a name without a hash (shouldn't happen on v1.5) → matched against current names;
 * - 'none': no player, or a partial player with neither (client start, login stat sync, PLUGIN-1).
 */
export type IdentityClaim =
  { kind: 'hash'; accountHash: string } | { kind: 'name'; name: string } | { kind: 'none' };

export function identityClaim(player: PlayerSnapshot | null): IdentityClaim {
  if (player?.accountHash !== undefined) return { kind: 'hash', accountHash: player.accountHash };
  if (player?.name !== undefined) return { kind: 'name', name: player.name };
  return { kind: 'none' };
}

/**
 * The account whose CURRENT name normalizes like `name` (RuneLite's toJagexName, lowercased), when
 * exactly one of the accounts `userId` is already linked to does. Null for no match, several
 * matches, or a name that normalizes to '' (which must never match: e.g. only non-ASCII characters).
 *
 * Only the user's own links are searched: a display name is public while the salted accountHash is
 * never shown, so matching every account would let any member attach themselves to someone else's
 * account as a contributor (who sees every category, private ones included) or claim an unclaimed
 * one, with a hand-made {"player":{"name":…}}. The fallback exists for a device that already
 * reports the account; a blocked link still matches, and the transaction then stores nothing.
 */
export async function findAccountByName(
  db: Db,
  name: string,
  userId: string,
): Promise<number | null> {
  const normalized = normalizeName(name);
  if (normalized === '') return null;
  const rows = await db
    .select({ id: osrsAccounts.id })
    .from(osrsAccounts)
    .innerJoin(
      accountLinks,
      and(eq(accountLinks.accountId, osrsAccounts.id), eq(accountLinks.userId, userId)),
    )
    .where(eq(osrsAccounts.nameNormalized, normalized))
    .limit(2);
  return rows.length === 1 && rows[0] ? rows[0].id : null;
}

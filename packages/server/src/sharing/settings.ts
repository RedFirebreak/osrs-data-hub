/**
 * Reading an account's sharing settings (the sharing panel, handoff §10 and §12) and the grant
 * picker's member list.
 */
import {
  CATEGORIES,
  effectiveAudience,
  type Audience,
  type Category,
  type Viewer,
} from '@hub/core';
import { accountLinks, accountShareGrants, users, type DbOrTx } from '@hub/db';
import { asc, eq, sql } from 'drizzle-orm';
import { loadVisibleAccount } from '../accounts/load';

export interface SharingCategory {
  category: Category;
  audience: Audience;
  /** No explicit choice is stored: the category follows its default audience (D-22). */
  isDefault: boolean;
  /** Users granted this category; they see it while the audience is 'selected'. */
  grants: { userId: string; name: string }[];
}

export interface SharingContributor {
  userId: string;
  name: string;
  image: string | null;
  role: 'owner' | 'contributor';
  blocked: boolean;
  /** When this user's devices first and last reported the account. */
  firstSeen: string;
  lastSeen: string;
}

export interface SharingSettings {
  /** The viewer may change these settings (the owner, or an admin override). */
  canManage: boolean;
  /** Every category, in CATEGORIES order. */
  categories: SharingCategory[];
  /** Every linked user, blocked ones included; the owner first, then by first report. */
  contributors: SharingContributor[];
}

export interface ActiveMember {
  userId: string;
  name: string;
  image: string | null;
}

/**
 * The sharing settings of an account, readable by its owner, its (non-blocked) contributors and
 * admins; null for anyone else, including members who can see the account's data and viewers who
 * can't see the account at all (the route answers 404 either way). Only `canManage` may change them.
 * A contributor's role comes from osrs_accounts.owner_user_id, the source of truth.
 */
export async function getSharingSettings(
  db: DbOrTx,
  viewer: Viewer,
  publicId: string,
): Promise<SharingSettings | null> {
  const entry = await loadVisibleAccount(db, viewer, publicId);
  if (!entry) return null;
  const { account, raw, access } = entry;
  const mayRead =
    access.relation === 'owner' || access.relation === 'contributor' || access.canManage;
  if (!mayRead) return null;

  const grants = await db
    .select({
      category: accountShareGrants.category,
      userId: accountShareGrants.granteeUserId,
      name: users.name,
    })
    .from(accountShareGrants)
    .innerJoin(users, eq(users.id, accountShareGrants.granteeUserId))
    .where(eq(accountShareGrants.accountId, account.id))
    .orderBy(sql`lower(${users.name})`, asc(users.id));
  const links = await db
    .select({
      userId: accountLinks.userId,
      name: users.name,
      image: users.image,
      blocked: accountLinks.blocked,
      firstSeen: accountLinks.firstSeen,
      lastSeen: accountLinks.lastSeen,
    })
    .from(accountLinks)
    .innerJoin(users, eq(users.id, accountLinks.userId))
    .where(eq(accountLinks.accountId, account.id))
    .orderBy(asc(accountLinks.firstSeen), asc(accountLinks.userId));

  const isOwner = (userId: string) => userId === account.ownerUserId;
  return {
    canManage: access.canManage,
    categories: CATEGORIES.map((category) => ({
      category,
      audience: effectiveAudience(raw, category),
      isDefault: !Object.hasOwn(raw.sharing, category),
      grants: grants
        .filter((g) => g.category === category)
        .map((g) => ({ userId: g.userId, name: g.name })),
    })),
    contributors: links
      .map((l): SharingContributor => ({
        userId: l.userId,
        name: l.name,
        image: l.image,
        role: isOwner(l.userId) ? 'owner' : 'contributor',
        blocked: l.blocked,
        firstSeen: l.firstSeen.toISOString(),
        lastSeen: l.lastSeen.toISOString(),
      }))
      // Stable: links are already ordered by first report.
      .sort((a, b) => Number(isOwner(b.userId)) - Number(isOwner(a.userId))),
  };
}

/** Active members for the grant picker, by name. Users in their grace period are left out. */
export async function listActiveMembers(db: DbOrTx): Promise<ActiveMember[]> {
  return db
    .select({ userId: users.id, name: users.name, image: users.image })
    .from(users)
    .where(eq(users.status, 'active'))
    .orderBy(sql`lower(${users.name})`, asc(users.id));
}

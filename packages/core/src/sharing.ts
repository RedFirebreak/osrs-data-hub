import { notImplemented } from './todo';

export const CATEGORIES = [
  'stats',
  'events',
  'activity',
  'location_live',
  'location_history',
  'equipment',
  'inventory',
] as const;
export type Category = (typeof CATEGORIES)[number];

export const AUDIENCES = ['private', 'guild', 'selected'] as const;
export type Audience = (typeof AUDIENCES)[number];

/** Handoff §10 defaults (D-22). A missing account_sharing row means the default. */
export const DEFAULT_AUDIENCE: Readonly<Record<Category, Audience>> = {
  stats: 'guild',
  events: 'guild',
  activity: 'guild',
  location_live: 'private',
  location_history: 'private',
  equipment: 'private',
  inventory: 'private',
};

export const CATEGORY_LABELS: Readonly<Record<Category, { label: string; covers: string }>> = {
  stats: { label: 'Stats', covers: 'skills, XP history, gains, levels' },
  events: { label: 'Events', covers: 'loot, level-ups, deaths, collection log, diaries, combat tasks, superiors' },
  activity: { label: 'Activity', covers: 'online status, world, sessions and playtime, HP, prayer, spellbook' },
  location_live: { label: 'Live location', covers: 'current coordinates (for the live map)' },
  location_history: { label: 'Location history', covers: 'the 30-day trail' },
  equipment: { label: 'Equipment', covers: 'current gear and its change log' },
  inventory: { label: 'Inventory', covers: 'current inventory and wealth history' },
};

export interface Viewer {
  userId: string;
  status: 'active' | 'grace';
  isAdmin: boolean;
}

/** Everything about an account that decides who may see what. */
export interface AccountAccess {
  status: 'active' | 'hidden';
  ownerUserId: string | null;
  links: readonly { userId: string; role: 'owner' | 'contributor'; blocked: boolean }[];
  /** Explicit audiences; missing categories use DEFAULT_AUDIENCE. */
  sharing: Readonly<Partial<Record<Category, Audience>>>;
  grants: readonly { category: Category; userId: string }[];
}

export type Relation = 'owner' | 'contributor' | 'member' | 'none';

export interface ResolvedAccess {
  /** The viewer may know this account exists (list it). */
  visible: boolean;
  /** Categories the viewer may read. */
  categories: ReadonlySet<Category>;
  relation: Relation;
  /** May change sharing, grants, ownership and blocks: the owner, or an admin (admin override). */
  canManage: boolean;
}

/**
 * The one permission resolver (handoff §10, D-22), used by the UI, the SSE filter and the API:
 * - A viewer whose status isn't 'active' sees nothing (visible false, no categories, canManage false).
 * - relation: owner if ownerUserId === viewer; contributor if a NON-blocked link exists; else member.
 *   A blocked contributor is treated as a plain member.
 * - Owner and contributors see every category.
 * - Otherwise per category: audience guild → allowed; selected → allowed iff a grant (category,
 *   viewer) exists; private → denied.
 * - Hidden accounts (owner in grace, no transfer) are invisible to everyone except admins: for a
 *   non-admin, visible false and no categories, even for contributors. Admins get the normal rules.
 * - visible = relation is owner/contributor, OR at least one category is allowed, OR (admin).
 * - canManage = viewer is owner or viewer.isAdmin (and the viewer is active).
 */
export function resolveAccess(viewer: Viewer, account: AccountAccess): ResolvedAccess {
  return notImplemented('resolveAccess');
}

export function effectiveAudience(account: Pick<AccountAccess, 'sharing'>, category: Category): Audience {
  return notImplemented('effectiveAudience');
}

/**
 * Removes location data from event data the viewer may not see: `data.location` of death and
 * superior_spawn events is stripped unless categories include location_live or location_history.
 * `eventData` is the stored original event {type, data, eventId, timestamp}; returns a copy (or the
 * same object when nothing changes). Other event types are returned unchanged.
 */
export function redactEventData(type: string, eventData: unknown, categories: ReadonlySet<Category>): unknown {
  return notImplemented('redactEventData');
}

export function isCategory(value: unknown): value is Category {
  return notImplemented('isCategory');
}

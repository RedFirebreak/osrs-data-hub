import { isRecord } from './guards';

export const CATEGORIES = [
  'stats',
  'events',
  'activity',
  'location_live',
  'location_history',
  'equipment',
  'inventory',
  'hiscores',
] as const;
export type Category = (typeof CATEGORIES)[number];

export const AUDIENCES = ['private', 'guild', 'selected'] as const;
export type Audience = (typeof AUDIENCES)[number];

/** A hub user: `active`, or in `grace` while offboarding (sees nothing until restored). */
export const USER_STATUSES = ['active', 'grace'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

/** An OSRS account: `active`, or `hidden` while its owner is in grace and nobody took it over. */
export const ACCOUNT_STATUSES = ['active', 'hidden'] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

/** How a user is linked to an account their device reported. */
export const LINK_ROLES = ['owner', 'contributor'] as const;
export type LinkRole = (typeof LINK_ROLES)[number];

/**
 * Every category is shared with the guild by default (D-96, superseding the handoff §10 defaults of
 * D-22 and D-82). A missing account_sharing row means the default.
 */
export const DEFAULT_AUDIENCE: Readonly<Record<Category, Audience>> = {
  stats: 'guild',
  events: 'guild',
  activity: 'guild',
  location_live: 'guild',
  location_history: 'guild',
  equipment: 'guild',
  inventory: 'guild',
  hiscores: 'guild',
};

export const CATEGORY_LABELS: Readonly<Record<Category, { label: string; covers: string }>> = {
  stats: { label: 'Stats', covers: 'skills, XP history, gains, levels' },
  events: {
    label: 'Events',
    covers: 'loot, level-ups, deaths, collection log, diaries, combat tasks, superiors',
  },
  activity: {
    label: 'Activity',
    covers: 'online status, world, sessions and playtime, HP, prayer, spellbook',
  },
  location_live: { label: 'Live location', covers: 'current coordinates (for the live map)' },
  // No number of days: how long the trail is kept is LOCATION_RETENTION_DAYS (the privacy page says).
  location_history: { label: 'Location history', covers: 'the trail of past positions' },
  equipment: { label: 'Equipment', covers: 'current gear and its change log' },
  inventory: { label: 'Inventory', covers: 'current inventory and wealth history' },
  hiscores: {
    label: 'Hiscores',
    covers: 'ranks, boss kill counts, clues and minigames from the official hiscores',
  },
};

export interface Viewer {
  userId: string;
  status: UserStatus;
  isAdmin: boolean;
}

/**
 * The guild audience itself as a principal (D-89): what an active guild member who is neither the
 * owner, a contributor nor a grantee of an account sees, i.e. exactly the categories whose audience
 * is `guild`. Service keys (D-88) act as this principal; it never owns, manages or is granted
 * anything, and the admin override never applies to it.
 */
export interface GuildAudience {
  readonly kind: 'guild_audience';
}

export const GUILD_AUDIENCE: GuildAudience = Object.freeze({ kind: 'guild_audience' as const });

/** Whom the resolver evaluates: a signed-in user, or the guild audience. */
export type Principal = Viewer | GuildAudience;

export function isGuildAudience(principal: Principal): principal is GuildAudience {
  return (principal as GuildAudience).kind === 'guild_audience';
}

/** Whether the principal may see anything at all: an active user, or the guild audience. */
export function isActivePrincipal(principal: Principal): boolean {
  return isGuildAudience(principal) || principal.status === 'active';
}

/** Only a signed-in user with isAdmin === true (fails closed); the guild audience never is. */
export function isAdminPrincipal(principal: Principal): boolean {
  return !isGuildAudience(principal) && principal.isAdmin === true;
}

/** Everything about an account that decides who may see what. */
export interface AccountAccess {
  status: AccountStatus;
  ownerUserId: string | null;
  links: readonly { userId: string; role: LinkRole; blocked: boolean }[];
  /** Explicit audiences; missing categories use DEFAULT_AUDIENCE. */
  sharing: Readonly<Partial<Record<Category, Audience>>>;
  grants: readonly { category: Category; userId: string }[];
  /**
   * The owner hid the account from the guild (D-104): nobody but its owner and contributors may see
   * it, whatever its audiences and grants say. Only `false` means shown (fails closed).
   */
  hiddenFromGuild: boolean;
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
 * - The guild audience (GUILD_AUDIENCE, D-89) is an active member with no relation to any account:
 *   it gets the categories whose effective audience is `guild`, relation 'member', never canManage,
 *   and hidden accounts stay invisible to it.
 * - A viewer whose status isn't 'active' sees nothing (visible false, no categories, canManage false,
 *   relation 'none').
 * - relation: owner if ownerUserId === viewer; contributor if a NON-blocked link exists; else member.
 *   A blocked contributor is treated as a plain member.
 * - Owner and contributors see every category.
 * - Otherwise per category: audience guild → allowed; selected → allowed iff a grant (category,
 *   viewer) exists; private → denied.
 * - Hidden accounts (owner in grace, no transfer) are invisible to everyone except admins: for a
 *   non-admin, visible false, no categories, canManage false and relation 'none', even for
 *   contributors (and an owner). Admins get the normal rules.
 * - An account hidden from the guild (hiddenFromGuild, D-104) keeps its owner and contributors as
 *   they are, and gives everyone else no category at all: audiences and grants don't apply. So a
 *   member sees nothing (relation 'none'), the guild audience too, and an admin keeps only the
 *   admin override (visible, canManage, no categories).
 * - visible = relation is owner/contributor, OR at least one category is allowed, OR (admin).
 * - canManage = viewer is owner or viewer.isAdmin (and the viewer is active).
 * So relation 'none' means "sees nothing"; owner/contributor always imply visible, and canManage
 * always implies visible. Fails closed on malformed input: only isAdmin === true is an admin, and
 * only blocked === false is a non-blocked link.
 */
export function resolveAccess(principal: Principal, account: AccountAccess): ResolvedAccess {
  if (isGuildAudience(principal)) return resolveGuildAudience(account);
  const viewer = principal;
  const isAdmin = viewer.isAdmin === true;
  if (viewer.status !== 'active') return noAccess();
  if (account.status !== 'active' && !isAdmin) return noAccess();

  const relation = relationOf(viewer.userId, account);
  const categories = new Set<Category>();
  if (relation === 'owner' || relation === 'contributor') {
    for (const c of CATEGORIES) categories.add(c);
  } else if (isHiddenFromGuild(account)) {
    if (!isAdmin) return noAccess();
  } else {
    for (const c of CATEGORIES) {
      const audience = effectiveAudience(account, c);
      if (audience === 'guild') categories.add(c);
      else if (audience === 'selected' && hasGrant(account, c, viewer.userId)) categories.add(c);
    }
  }
  return {
    visible: relation !== 'member' || categories.size > 0 || isAdmin,
    categories,
    relation,
    canManage: relation === 'owner' || isAdmin,
  };
}

/** The guild audience's access (D-89): the `guild` categories of an active account, nothing else. */
function resolveGuildAudience(account: AccountAccess): ResolvedAccess {
  if (account.status !== 'active' || isHiddenFromGuild(account)) return noAccess();
  const categories = new Set<Category>();
  for (const c of CATEGORIES) if (effectiveAudience(account, c) === 'guild') categories.add(c);
  return { visible: categories.size > 0, categories, relation: 'member', canManage: false };
}

/** The account is hidden from the guild (D-104); anything but an explicit `false` counts as hidden. */
export function isHiddenFromGuild(account: Pick<AccountAccess, 'hiddenFromGuild'>): boolean {
  return account.hiddenFromGuild !== false;
}

function noAccess(): ResolvedAccess {
  return { visible: false, categories: new Set(), relation: 'none', canManage: false };
}

function relationOf(userId: string, account: AccountAccess): Exclude<Relation, 'none'> {
  if (account.ownerUserId !== null && account.ownerUserId === userId) return 'owner';
  // Any non-blocked link counts, whatever its role (a stale 'owner' link after a transfer included).
  if (account.links.some((l) => l.userId === userId && l.blocked === false)) return 'contributor';
  return 'member';
}

function hasGrant(account: AccountAccess, category: Category, userId: string): boolean {
  return account.grants.some((g) => g.category === category && g.userId === userId);
}

/**
 * The audience of one category: the explicit account_sharing value, else DEFAULT_AUDIENCE. Fails
 * closed to 'private' for a stored value that isn't a known audience, and for a `category` that isn't
 * one at runtime (so e.g. an unchecked "toString" from a query string can't read Object.prototype).
 */
export function effectiveAudience(
  account: Pick<AccountAccess, 'sharing'>,
  category: Category,
): Audience {
  if (!isCategory(category)) return 'private';
  const explicit: unknown = Object.hasOwn(account.sharing, category)
    ? account.sharing[category]
    : undefined;
  if (explicit === undefined || explicit === null) return DEFAULT_AUDIENCE[category];
  return isAudience(explicit) ? explicit : 'private';
}

function isAudience(value: unknown): value is Audience {
  return typeof value === 'string' && (AUDIENCES as readonly string[]).includes(value);
}

/**
 * Removes location data from event data the viewer may not see: `data.location` is stripped unless
 * categories include location_live or location_history. In v1.5 only death and superior_spawn events
 * carry one, but the rule applies to every event whatever its type (fail closed): unknown types are
 * stored as sent and newer plugins may add fields to known types, and a `location` is coordinates
 * either way. So the function doesn't take the type. `eventData` is the stored original event
 * {type, data, eventId, timestamp}; returns a copy (or the same object when nothing changes); the input
 * is never mutated. A top-level `location` (inner data passed by mistake) is stripped too.
 */
export function redactEventData(eventData: unknown, categories: ReadonlySet<Category>): unknown {
  if (categories.has('location_live') || categories.has('location_history')) return eventData;
  if (!isRecord(eventData)) return eventData;

  const inner = eventData.data;
  const innerHasLocation = isRecord(inner) && Object.hasOwn(inner, 'location');
  const topHasLocation = Object.hasOwn(eventData, 'location');
  if (!innerHasLocation && !topHasLocation) return eventData;

  const out: Record<string, unknown> = { ...eventData };
  if (topHasLocation) delete out.location;
  if (innerHasLocation) {
    const data: Record<string, unknown> = { ...inner };
    delete data.location;
    out.data = data;
  }
  return out;
}

export function isCategory(value: unknown): value is Category {
  return typeof value === 'string' && (CATEGORIES as readonly string[]).includes(value);
}

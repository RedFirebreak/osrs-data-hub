/**
 * The public API v1's schemas (handoff §13, D-71, D-75, D-77), one source of truth for three things:
 * - parsing every endpoint's query and path parameters (strict: a malformed value is a ZodError, which
 *   handleApi answers 400 `invalid_request` with field details; unknown parameters are ignored, so
 *   adding one later stays compatible);
 * - the OpenAPI document (openapi.ts: `io: 'input'` for parameters, `io: 'output'` for responses);
 * - the route tests, which parse every real response body with its schema, so the docs can't drift
 *   from what the routes send.
 *
 * Wire names are snake_case for every key the hub defines (D-77); keys that are data (skill, slot,
 * item and account names, an event's `data`) pass through as they are (wire.ts maps them). Caps are
 * @hub/server's exported limits, so the docs state the numbers the server enforces; the read models
 * re-validate everything anyway.
 */
import { CATEGORIES, KNOWN_EVENT_TYPES } from '@hub/core';
import { API_KEY_KINDS, SESSION_END_REASONS } from '@hub/db';
import {
  EVENTS_DEFAULT_LIMIT,
  EVENTS_MAX_LIMIT,
  GAINS_PERIODS,
  HISTORY_DEFAULT_DAYS,
  LEADERBOARD_PERIODS,
  LOOT_LEADERBOARD_DEFAULT_LIMIT,
  LOOT_LEADERBOARD_MAX_LIMIT,
  MAX_BULK_ACCOUNTS,
  MAX_BULK_ACCOUNTS_SERVICE,
  MAX_LIST_PARAM,
  MAX_SERIES_POINTS,
  MAX_XP_SKILLS,
  SNAPSHOT_SINCE_OVERLAP_MS,
  XP_DEFAULT_DAYS,
  XP_RESOLUTIONS,
  decodeEventsCursor,
} from '@hub/server';
import { z } from 'zod';
import { accountId as accountIdItem, isoInstant as instant } from '@/lib/query';

// ─── Parameters ────────────────────────────────────────────────────────────────────────────────

/** The `{id}` path parameter. A value that can't be an id is answered 404 like an unknown one (D-70). */
export const AccountPath = z.object({
  id: accountIdItem.meta({
    description: "The account's public id (opaque, base62), as `id` in `/accounts`.",
    example: '4fT9kQ2mXa7B',
  }),
});

/**
 * A comma-separated list (`skills=attack,defence`): entries trimmed, duplicates dropped (first kept),
 * then at most `max` entries (the server's cap, counted as it counts them). An empty value is an
 * empty list, which each endpoint treats like the parameter being absent; an empty entry (`a,,b`) is
 * an error.
 */
function csv(item: z.ZodString, max?: number, min = 0) {
  let list = z.array(item.min(1, 'empty value'));
  if (min > 0) list = list.min(min, `must list at least ${min}`);
  if (max !== undefined) list = list.max(max, `at most ${max} values`);
  return z
    .string()
    .transform((s) => (s === '' ? [] : [...new Set(s.split(',').map((v) => v.trim()))]))
    .pipe(list);
}

/** A whole number in [min, max] written as plain digits. */
function wholeNumber(min: number, max: number) {
  return z
    .string()
    .regex(/^\d{1,16}$/, 'must be a whole number')
    .transform(Number)
    .pipe(z.number().int().min(min).max(max));
}

const from = instant.optional();
const to = instant.optional();

function rangeShape(defaultDays: number) {
  return {
    from: from.meta({
      description: `Start of the range (ISO-8601 date-time). Default: \`to\` − ${defaultDays} days.`,
    }),
    to: to.meta({ description: 'End of the range (ISO-8601 date-time). Default: now.' }),
  };
}

/** GET /accounts. */
export const AccountsQuery = z.object({
  names: csv(z.string())
    .optional()
    .meta({
      description: `Comma-separated display names, matched case-insensitively the way the game does (at most ${MAX_LIST_PARAM}). With \`names\` and/or \`ids\`, only matching accounts are returned; names that match nothing are simply absent.`,
      example: 'Zezima,Lynx Titan',
    }),
  ids: csv(accountIdItem, MAX_LIST_PARAM)
    .optional()
    .meta({ description: `Comma-separated account ids (at most ${MAX_LIST_PARAM}).` }),
  online: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional()
    .meta({
      description:
        '`true`: only accounts in game now; `false`: only accounts known to be offline. Accounts whose `activity` the key can’t read never pass this filter.',
    }),
});

/** GET /snapshot. */
export const SnapshotQuery = z.object({
  since: instant.optional().meta({
    description: `Only accounts that changed after this time (pass the previous response’s \`meta.last_modified\`). Accounts changed up to ${SNAPSHOT_SINCE_OVERLAP_MS / 1000} s before it are sent again (late commits), and accounts whose \`activity\` the key can’t read are always sent.`,
  }),
});

const skillsParam = csv(z.string(), MAX_XP_SKILLS)
  .optional()
  .meta({
    description: `Comma-separated skill names, case-insensitive (\`attack,defence\`, \`overall\`); at most ${MAX_XP_SKILLS}. Default: Overall. An unknown skill is a 400.`,
  });

const resolutionParam = z
  .enum(XP_RESOLUTIONS)
  .optional()
  .meta({
    description: `Bucket size. \`auto\` (default): 5m up to 7 days, 1h up to 90 days, 1d beyond. The hub picks a coarser one when the range would have more than ${MAX_SERIES_POINTS} points, or starts before the 5-minute tier’s retention.`,
  });

/** GET /accounts/{id}/xp. */
export const XpQuery = z.object({
  skills: skillsParam,
  resolution: resolutionParam,
  ...rangeShape(XP_DEFAULT_DAYS),
});

/**
 * The `accounts` list of a bulk request (`/xp`, `/locations`, D-92): parsed up to the service
 * keys' cap; the read model refuses more than MAX_BULK_ACCOUNTS for a user key (400).
 */
function bulkAccountsParam(category: string) {
  return csv(accountIdItem, MAX_BULK_ACCOUNTS_SERVICE, 1).meta({
    description: `Comma-separated account ids: 1 to ${MAX_BULK_ACCOUNTS} with a user key, 1 to ${MAX_BULK_ACCOUNTS_SERVICE} with a service key. Each must be one whose \`${category}\` the key may read, else 404.`,
  });
}

/** GET /xp. */
export const XpMultiQuery = z.object({
  accounts: bulkAccountsParam('stats'),
  skills: skillsParam,
  resolution: resolutionParam,
  ...rangeShape(XP_DEFAULT_DAYS),
});

/** GET /accounts/{id}/gains. */
export const GainsQuery = z.object({
  period: z.enum(GAINS_PERIODS).optional().meta({
    description:
      '`day` = since local midnight in the key creator’s time zone (their hub settings); `week`/`month`/`year` = the last 7/30/365 days. Default `day`. Not together with `from`/`to`.',
  }),
  from: from.meta({ description: 'An explicit range instead of `period`.' }),
  to: to.meta({ description: 'With `from`; default now.' }),
});

/** What an event's `type` can be, for the descriptions: the known types, as stored, and the rest. */
const EVENT_TYPE_NAMES = `${KNOWN_EVENT_TYPES.join(', ')}, or an unknown plugin type as sent`;

/** GET /events. */
export const EventsQuery = z.object({
  cursor: z
    .string()
    .refine((c) => c === 'now' || decodeEventsCursor(c) !== null, 'not a cursor from this feed')
    .optional()
    .meta({
      description:
        'Omitted: the newest `limit` events and a cursor after them. `now`: no events, only the current cursor (start following from here). Otherwise a `meta.next_cursor` from an earlier response: the events after it, oldest first. Cursors are opaque.',
    }),
  types: csv(z.string())
    .optional()
    .meta({
      description: `Comma-separated event types: ${EVENT_TYPE_NAMES}. Default: every type.`,
      example: 'loot,level_up',
    }),
  accounts: csv(accountIdItem, MAX_LIST_PARAM)
    .optional()
    .meta({
      description: `Comma-separated account ids (at most ${MAX_LIST_PARAM}); each must be one whose \`events\` the key may read, else 404. Default: every such account.`,
    }),
  min_value: wholeNumber(0, Number.MAX_SAFE_INTEGER).optional().meta({
    description: 'Only events with `value_gp` ≥ this (events without a value are left out).',
  }),
  limit: wholeNumber(1, EVENTS_MAX_LIMIT)
    .optional()
    .meta({
      description: `Events per page, 1 to ${EVENTS_MAX_LIMIT}. Default ${EVENTS_DEFAULT_LIMIT}.`,
    }),
});

/** GET /accounts/{id}/sessions, /equipment-history, /wealth, /locations. */
export const HistoryQuery = z.object(rangeShape(HISTORY_DEFAULT_DAYS));

/** GET /locations. */
export const LocationsMultiQuery = z.object({
  accounts: bulkAccountsParam('location_history'),
  ...rangeShape(HISTORY_DEFAULT_DAYS),
});

/** The `period` of both leaderboards (/leaderboards/gains and /leaderboards/loot). */
const leaderboardPeriod = z.enum(LEADERBOARD_PERIODS).optional().meta({
  description:
    '`day` = since local midnight in the key creator’s time zone; `week`/`month` = the last 7/30 days. Default `day`.',
});

/** GET /leaderboards/gains. */
export const LeaderboardQuery = z.object({
  skill: z.string().min(1, 'empty value').optional().meta({
    description:
      'One skill, case-insensitive (`overall` works). Without it: Overall first, then every skill anyone gained XP in.',
  }),
  period: leaderboardPeriod,
});

/** GET /leaderboards/loot. */
export const LootLeaderboardQuery = z.object({
  period: leaderboardPeriod,
  limit: wholeNumber(1, LOOT_LEADERBOARD_MAX_LIMIT)
    .optional()
    .meta({
      description: `Drops to return, 1 to ${LOOT_LEADERBOARD_MAX_LIMIT}. Default ${LOOT_LEADERBOARD_DEFAULT_LIMIT}.`,
    }),
});

// ─── Responses ─────────────────────────────────────────────────────────────────────────────────

const timestamp = z.iso.datetime().meta({ description: 'ISO-8601 UTC.' });
const int = z.number().int();
const category = z.enum(CATEGORIES);

export const AccountRef = z
  .object({
    id: z.string().meta({ description: 'Public account id.' }),
    name: z.string().meta({ description: 'Current display name.' }),
  })
  .meta({ description: 'An account: its public id and current display name.' });

export const Owner = z
  .object({
    name: z.string().meta({ description: 'The owner’s display name on the hub.' }),
    discord_id: z
      .string()
      .nullable()
      .meta({ description: 'The owner’s Discord user id; null for a user without one.' }),
  })
  .meta({
    description:
      'The account’s owner, as the guild page shows them to every member: for linking hub accounts to people. Never a contributor.',
  });

export const Meter = z.object({ current: int, max: int }).meta({
  description: 'HP or prayer: the current (boosted, so it can exceed max) and the maximum.',
});

export const Item = z
  .object({
    id: int,
    name: z.string().nullable().meta({ description: 'null when the plugin didn’t send a name.' }),
    quantity: int,
    ge_price: int.meta({ description: 'Per-unit Grand Exchange price.' }),
    ha_price: int
      .nullable()
      .meta({ description: 'Per-unit high-alchemy value; null when not sent.' }),
    equipment_slot: z
      .string()
      .nullable()
      .meta({ description: 'HEAD, CAPE, WEAPON, … on equipment items; null in the inventory.' }),
    inventory_slot: int.nullable().meta({
      description:
        'Inventory slot 0–27 (left to right, then top to bottom) on inventory items from plugin 1.5.1; null from older plugins and on equipment.',
    }),
  })
  .meta({ description: 'An item as the plugin sent it (inventory: one entry per occupied slot).' });

export const Skill = z.object({
  skill: z.string().meta({
    description: 'The plugin’s skill name ("Attack", …); "Overall" is derived by the hub.',
  }),
  level: int.meta({ description: 'As sent: virtual above 99. For Overall, the real total level.' }),
  real_level: int.meta({ description: 'min(level, 99); for Overall the real total level.' }),
  xp: int,
});

const skillsShape = {
  total_level: int.meta({ description: 'Σ min(level, 99), as the game shows it.' }),
  overall_xp: int,
  skills: z.array(Skill).meta({ description: 'Overall first, then the in-game grid order.' }),
};
export const Skills = z.object(skillsShape);

const itemsShape = {
  items: z.array(Item),
  value: int.meta({ description: 'Σ ge_price × quantity.' }),
};
export const Items = z.object(itemsShape);

const presenceShape = {
  online: z.boolean().meta({ description: 'In game now.' }),
  world: int.nullable().meta({ description: 'Last known world, also while offline.' }),
  special_world: z
    .boolean()
    .meta({ description: 'The last known world is a special one (league, deadman, …).' }),
  game_state: z
    .string()
    .nullable()
    .meta({ description: 'Last game state as sent (LOGGED_IN, LOGIN_SCREEN, HOPPING, …).' }),
  last_seen: timestamp.meta({
    description: 'When the hub last received anything for the account.',
  }),
};

const vitalsShape = {
  hp: Meter.nullable(),
  prayer: Meter.nullable(),
  spellbook: z.string().nullable(),
};

const locationShape = {
  x: int,
  y: int,
  plane: int,
  is_on_boat: z.boolean(),
  stale: z.boolean().meta({
    description: 'No location received for more than 2 minutes: the player may be elsewhere now.',
  }),
};

/**
 * One section of GET /accounts/{id}: `{ shared: true, updated_at, …data }`, or `{ shared: false,
 * updated_at: null }` when the key may read the category but the plugin never sent the section.
 */
function section<S extends z.core.$ZodLooseShape>(shape: S, description: string) {
  return z
    .discriminatedUnion('shared', [
      z.object({
        shared: z.literal(true),
        updated_at: timestamp.meta({ description: 'When the hub last received this section.' }),
        ...shape,
      }),
      z.object({ shared: z.literal(false), updated_at: z.null() }),
    ])
    .optional()
    .meta({
      description: `${description} \`{ "shared": false, "updated_at": null }\` when the player’s plugin never sent it; the key omitted when the key can’t read the category on this account.`,
    });
}

const accountHead = {
  id: z.string(),
  name: z.string(),
  account_hash: z.string().optional().meta({
    description:
      'The plugin’s salted SHA-224 `accountHash`, the account’s identity for anything the plugin sends to. **Service keys only**; omitted for user keys.',
  }),
  type: int.nullable().meta({
    description: '0 normal, 1 IM, 2 UIM, 3 HCIM, 4 GIM, 5 HCGIM, 6 UGIM; null never sent.',
  }),
  type_label: z.string().meta({ description: '"Normal", "Ironman", … ("Unknown" for null).' }),
  owner: Owner.nullable().meta({
    description:
      'The account’s owner; null when it has none or the owner is no longer an active member.',
  }),
};

const categoriesField = z
  .array(category)
  .meta({ description: 'What this key may read on this account right now.' });

// GET /me
const MeData = z.object({
  key: z.object({
    id: z.uuid(),
    kind: z.enum(API_KEY_KINDS).meta({
      description:
        '`user`: a member’s own key, reading what its creator may see. `service`: an integration key an admin created; it belongs to nobody and reads what the guild audience sees (accounts and categories shared with the guild).',
    }),
    name: z.string(),
    prefix: z.string().meta({ description: 'The key is `ohub_<prefix>_<secret>`.' }),
    categories: z.array(category),
    account_scope: z.enum(['all_visible', 'list']).meta({
      description:
        '`all_visible`: every account the creator can see, evaluated on every request; `list`: an explicit list. Always `all_visible` for a service key.',
    }),
    rate_limit_per_minute: int.min(1).meta({
      description: 'Requests this key may make per sliding minute (`X-RateLimit-Limit`).',
    }),
    expires_at: timestamp.nullable(),
  }),
  user: z
    .object({ name: z.string() })
    .nullable()
    .meta({ description: 'The key’s creator; null for a service key.' }),
  visible_accounts: int.min(0).meta({ description: 'Accounts the key can see right now.' }),
});

// GET /accounts
export const AccountSummary = z.object({
  ...accountHead,
  online: z.boolean().nullable().meta({ description: 'In game now; null without `activity`.' }),
  world: int.nullable().meta({ description: 'Last known world; null without `activity`.' }),
  last_seen: timestamp.nullable().meta({ description: 'null without `activity`.' }),
});
const AccountsData = z.array(AccountSummary);

// GET /accounts/{id}
export const AccountDetail = z.object({
  ...accountHead,
  first_seen: timestamp.meta({ description: 'When the hub first saw the account.' }),
  categories: categoriesField,
  presence: section(presenceShape, '`activity`.'),
  vitals: section(vitalsShape, '`activity`: HP, prayer, spellbook.'),
  skills: section(
    skillsShape,
    '`stats`. Without `activity`, `updated_at` is cut to the UTC day (the exact time would be the last-seen time).',
  ),
  location: section(locationShape, '`location_live`.'),
  equipment: section(itemsShape, '`equipment`: worn items.'),
  inventory: section(itemsShape, '`inventory`.'),
});

// GET /snapshot
export const SnapshotLocation = z.object({
  ...locationShape,
  updated_at: timestamp,
});

const inActivity = (description?: string) => ({
  description: `\`activity\`${description ? `: ${description}` : ''}. Omitted without it.`,
});

export const SnapshotAccount = z.object({
  ...accountHead,
  categories: categoriesField,
  online: z.boolean().optional().meta(inActivity('in game now')),
  world: int.nullable().optional().meta(inActivity('last known world')),
  special_world: z.boolean().optional().meta(inActivity()),
  game_state: presenceShape.game_state
    .optional()
    .meta(
      inActivity(
        'last game state as sent (LOGGED_IN, LOGIN_SCREEN, HOPPING, …); null once an in-game state timed out',
      ),
    ),
  last_seen: timestamp.optional().meta(inActivity('when the hub last heard from the account')),
  hp: Meter.nullable().optional().meta(inActivity()),
  prayer: Meter.nullable().optional().meta(inActivity()),
  spellbook: z.string().nullable().optional().meta(inActivity()),
  location: SnapshotLocation.nullable().optional().meta({
    description:
      '`location_live`: null when never sent, omitted without the category. `stale` after 2 minutes without a location.',
  }),
  skills: Skills.nullable()
    .optional()
    .meta({ description: '`stats`: null when never sent, omitted without the category.' }),
  equipment: Items.nullable()
    .optional()
    .meta({ description: '`equipment`: null when never sent, omitted without the category.' }),
  inventory: Items.nullable()
    .optional()
    .meta({ description: '`inventory`: null when never sent, omitted without the category.' }),
});
const SnapshotData = z.array(SnapshotAccount);

// XP
const resolution = z.enum(['5m', '1h', '1d']);
export const XpSeries = z.object({
  account: AccountRef,
  resolution: resolution.meta({ description: 'The resolution used.' }),
  from: timestamp,
  to: timestamp,
  series: z.array(
    z.object({
      skill: z.string(),
      points: z.array(z.tuple([timestamp, int])).meta({
        description:
          '[bucket start, XP at the end of that bucket], ascending. XP only changes where a point is; the value in effect at `from` is carried in as a first point at the range start.',
      }),
    }),
  ),
});
const XpMultiData = z.object({
  resolution,
  from: timestamp,
  to: timestamp,
  accounts: z.array(XpSeries).meta({ description: 'In request order.' }),
});

const GainsData = z.object({
  account: AccountRef,
  period: z.enum(GAINS_PERIODS).nullable().meta({ description: 'null for an explicit from/to.' }),
  from: timestamp,
  to: timestamp,
  gains: z
    .array(z.object({ skill: z.string(), xp: int }))
    .meta({ description: 'Every skill the account has, Overall first, then the grid order.' }),
});

// GET /events
export const Event = z.object({
  id: z.uuid().meta({ description: 'Public event id (uuid v7).' }),
  type: z.string().meta({
    description: `${EVENT_TYPE_NAMES}.`,
  }),
  account: AccountRef,
  occurred_at: timestamp.meta({
    description: 'The plugin’s time, clamped to [received − 15 min, received].',
  }),
  received_at: timestamp,
  value_gp: int.nullable().meta({ description: 'Loot value in GP where the type has one.' }),
  item_id: int.nullable(),
  npc_id: int.nullable(),
  skill: z.string().nullable(),
  level: int.nullable(),
  tier: z.string().nullable(),
  points: int.nullable(),
  special_world: z.boolean(),
  data: z.record(z.string(), z.unknown()).meta({
    description:
      'The event as the plugin sent it (`{type, data, eventId, timestamp}`), passed through unchanged: its shape depends on `type`. `data.location` (deaths, superior spawns) is removed unless the key reads `location_live` or `location_history` on the account.',
  }),
  title: z.string().meta({ description: 'Short title, e.g. "Loot".' }),
  line: z.string().meta({
    description: 'One line, e.g. "Zezima received Dragon warhammer (38.2M) from Lizardman shaman".',
  }),
});
const EventsData = z.array(Event);

// Histories
const historyHead = { account: AccountRef, from: timestamp, to: timestamp };

const SessionsData = z.object({
  ...historyHead,
  sessions: z
    .array(
      z.object({
        id: z.string(),
        started_at: timestamp,
        ended_at: timestamp.nullable().meta({ description: 'null while the session is open.' }),
        last_seen_at: timestamp,
        duration_ms: int.min(0),
        worlds: z.array(int),
        end_reason: z.enum(SESSION_END_REASONS).nullable(),
      }),
    )
    .meta({ description: 'Sessions overlapping the range, newest first.' }),
});

const EquipmentHistoryData = z.object({
  ...historyHead,
  changes: z
    .array(
      z.object({
        changed_at: timestamp,
        items: z.array(Item).meta({ description: 'The whole worn set after the change.' }),
      }),
    )
    .meta({ description: 'Newest first.' }),
});

const WealthData = z.object({
  ...historyHead,
  days: z
    .array(
      z.object({
        day: z.iso.date().meta({ description: 'UTC day.' }),
        last_value: int.meta({ description: 'Carried value at the day’s last update (GE).' }),
        max_value: int.meta({ description: 'The day’s highest carried value.' }),
      }),
    )
    .meta({ description: 'Oldest first.' }),
});

const LocationPoint = z.object({
  at: timestamp,
  x: int,
  y: int,
  plane: int,
  world: int.nullable(),
  is_on_boat: z.boolean(),
});

const locationPoints = z
  .array(LocationPoint)
  .meta({ description: 'At most one point per minute, oldest first.' });

const LocationsData = z.object({
  ...historyHead,
  points: locationPoints,
});

// GET /locations
export const AccountLocations = z.object({ account: AccountRef, points: locationPoints });
const LocationsMultiData = z.object({
  from: timestamp,
  to: timestamp,
  accounts: z.array(AccountLocations).meta({
    description: 'In request order; each trail is what `/accounts/{id}/locations` returns.',
  }),
});

const LeaderboardsData = z.object({
  period: z.enum(LEADERBOARD_PERIODS),
  from: timestamp,
  to: timestamp,
  leaderboards: z.array(
    z.object({
      skill: z.string(),
      entries: z
        .array(z.object({ rank: int.min(1), account: AccountRef, gain: int }))
        .meta({ description: 'Highest gain first, at most 10; only accounts that gained XP.' }),
    }),
  ),
});

const LootLeaderboardData = z.object({
  period: z.enum(LEADERBOARD_PERIODS),
  from: timestamp,
  to: timestamp,
  entries: z
    .array(
      z.object({
        rank: int.min(1),
        event: Event,
      }),
    )
    .meta({
      description:
        'Loot and PK loot with a value, not on a special world, that occurred in [from, to]: highest `value_gp` first (newest first on a tie), at most `limit`. Each `event` is exactly what `/events` serves.',
    }),
});

// Envelopes
const Meta = z.object({
  generated_at: timestamp.meta({ description: 'When the hub built this response.' }),
});
const ListMeta = Meta.extend({ count: int.min(0) });
const EventsMeta = ListMeta.extend({
  next_cursor: z.string().meta({
    description:
      'Pass as `cursor` next time. Always present; unchanged when nothing new has settled.',
  }),
});
const SnapshotMeta = ListMeta.extend({
  last_modified: timestamp.nullable().meta({
    description:
      'The newest change among the accounts whose `activity` the key reads, for the next `since`; null when it reads none.',
  }),
});

type MetaExtra<M extends z.ZodType> = Omit<z.infer<M>, 'generated_at'>;

/**
 * What a route adds to `meta` beside `generated_at` (v1Ok): nothing, or the fields one of the meta
 * schemas documents, so a misspelt or undocumented meta key doesn't compile.
 */
export type WireMetaExtra =
  | Record<string, never>
  | MetaExtra<typeof ListMeta>
  | MetaExtra<typeof EventsMeta>
  | MetaExtra<typeof SnapshotMeta>;

function envelope<D extends z.ZodType, M extends z.ZodType>(data: D, meta: M) {
  return z.object({ data, meta });
}

export const MeResponse = envelope(MeData, Meta);
export const AccountsResponse = envelope(AccountsData, ListMeta);
export const AccountResponse = envelope(AccountDetail, Meta);
export const SnapshotResponse = envelope(SnapshotData, SnapshotMeta);
export const XpResponse = envelope(XpSeries, Meta);
export const XpMultiResponse = envelope(XpMultiData, Meta);
export const GainsResponse = envelope(GainsData, Meta);
export const EventsResponse = envelope(EventsData, EventsMeta);
export const SessionsResponse = envelope(SessionsData, Meta);
export const EquipmentHistoryResponse = envelope(EquipmentHistoryData, Meta);
export const WealthResponse = envelope(WealthData, Meta);
export const LocationsResponse = envelope(LocationsData, Meta);
export const LocationsMultiResponse = envelope(LocationsMultiData, Meta);
export const LeaderboardsResponse = envelope(LeaderboardsData, Meta);
export const LootLeaderboardResponse = envelope(LootLeaderboardData, Meta);

export const ErrorResponse = z.object({
  error: z.object({
    code: z.string().meta({
      description:
        'invalid_request (400), unauthorized (401), not_found (404), rate_limited (429), unavailable (503), internal_error (500).',
    }),
    message: z.string(),
    details: z
      .array(z.object({ path: z.string(), message: z.string() }))
      .optional()
      .meta({ description: 'Field errors of a 400.' }),
  }),
});

export type WireMe = z.infer<typeof MeData>;
export type WireAccountSummary = z.infer<typeof AccountSummary>;
export type WireAccountDetail = z.infer<typeof AccountDetail>;
export type WireSnapshotAccount = z.infer<typeof SnapshotAccount>;
export type WireXpSeries = z.infer<typeof XpSeries>;
export type WireXpMulti = z.infer<typeof XpMultiData>;
export type WireGains = z.infer<typeof GainsData>;
export type WireEvent = z.infer<typeof Event>;
export type WireSessions = z.infer<typeof SessionsData>;
export type WireEquipmentHistory = z.infer<typeof EquipmentHistoryData>;
export type WireWealth = z.infer<typeof WealthData>;
export type WireLocations = z.infer<typeof LocationsData>;
export type WireLocationsMulti = z.infer<typeof LocationsMultiData>;
export type WireOwner = z.infer<typeof Owner>;
export type WireLeaderboards = z.infer<typeof LeaderboardsData>;
export type WireLootLeaderboard = z.infer<typeof LootLeaderboardData>;
export type WireItem = z.infer<typeof Item>;
export type WireSkills = z.infer<typeof Skills>;
export type WireItems = z.infer<typeof Items>;
export type WireSnapshotLocation = z.infer<typeof SnapshotLocation>;

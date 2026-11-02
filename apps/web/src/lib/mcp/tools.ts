/**
 * The MCP server's tools (handoff "MCP tools (v1)"): each one calls the API's read models with the
 * key's principal (D-130), never the hub over HTTP, and trims the answer for a model (D-132). Every
 * tool has a REST twin on /api/v1 (D-131), named in its description, and reads nothing that twin
 * doesn't. `account` inputs take a name or an id (D-134). Read-only, all of them.
 *
 * A tool that can't answer throws ToolError (or the read model's ApiError): the server turns either
 * into a tool result with `isError`, whose text the model reads and can act on.
 */
import { formatGpChange, gearTrips, type Category } from '@hub/core';
import type { DbOrTx } from '@hub/db';
import {
  KILLS_LEADERBOARD_PERIODS,
  LEADERBOARD_PERIODS,
  GAINS_PERIODS,
  PROGRESS_RANGES,
  apiAccountCategories,
  apiAccountCollectionLog,
  apiDay,
  apiEquipmentHistory,
  apiEventsInRange,
  apiGains,
  apiGetAccount,
  apiGuildCollectionLog,
  apiHiscoresMulti,
  apiKillsLeaderboard,
  apiLeaderboardGains,
  apiListAccounts,
  apiLocations,
  apiLootLeaderboard,
  apiProgress,
  apiSessions,
  apiWealth,
  placeStays,
  placesOf,
  type ApiEvent,
  type ApiHiscores,
  type ApiItem,
  type ApiPlace,
  type ApiPrincipal,
} from '@hub/server';
import { z } from 'zod';
import { ToolError, resolveAccount, resolveAccounts, type ResolvedAccount } from './resolve';
import { MCP_LIST_CAP, capped, compact, day, gp, minutes, plural, result } from './trim';

export interface ToolContext {
  db: DbOrTx;
  principal: ApiPrincipal;
  now: Date;
}

export type ToolResult = Record<string, unknown>;

export interface ToolDef<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  input: S;
  run(ctx: ToolContext, args: z.infer<z.ZodObject<S>>): Promise<ToolResult>;
}

function tool<S extends z.ZodRawShape>(def: ToolDef<S>): ToolDef {
  return def as unknown as ToolDef;
}

// ---------------------------------------------------------------------------------------------
// Inputs shared by several tools.

const account = z
  .string()
  .min(1)
  .max(64)
  .describe('An account: its in-game name (any case) or its id from hub://accounts.');

const accounts = z
  .array(account)
  .min(1)
  .max(50)
  .describe('Accounts by name or id. Leave out for every account the key can read.');

const when = z
  .string()
  .min(1)
  .max(40)
  .describe('An ISO date (2026-11-01, the whole day in UTC) or date-time (2026-11-01T18:00:00Z).');

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A `from`/`to` input as a Date. A bare date is that UTC day: its start as `from`, its end (the next
 * midnight, at most now) as `to`, so `from=to=2026-11-01` is that whole day.
 */
export function parseWhen(value: string, edge: 'from' | 'to', now: Date): Date {
  const text = value.trim();
  const date = new Date(DATE_ONLY.test(text) ? `${text}T00:00:00Z` : text);
  if (Number.isNaN(date.getTime())) {
    throw new ToolError(
      `"${value}" is not a date: use 2026-11-01 or 2026-11-01T18:00:00Z (ISO 8601).`,
    );
  }
  if (edge === 'to' && DATE_ONLY.test(text)) {
    return new Date(Math.min(date.getTime() + DAY_MS, now.getTime()));
  }
  return date;
}

function range(args: { from?: string; to?: string }, now: Date): { from?: Date; to?: Date } {
  return {
    ...(args.from !== undefined ? { from: parseWhen(args.from, 'from', now) } : {}),
    ...(args.to !== undefined ? { to: parseWhen(args.to, 'to', now) } : {}),
  };
}

/** Why a read model answered null: the key can't read that part of this account. */
export function notShared(who: ResolvedAccount, what: string, category: Category): ToolError {
  return new ToolError(
    `This key can't read ${who.name}'s ${what}: it needs the "${category}" category, and the owner has to share it with you. hub://me lists what the key may read.`,
  );
}

async function accountIds(ctx: ToolContext, refs: readonly string[] | undefined) {
  if (refs === undefined || refs.length === 0) return undefined;
  return (await resolveAccounts(ctx.db, ctx.principal, refs)).map((a) => a.id);
}

// ---------------------------------------------------------------------------------------------
// Shapes shared by several tools.

/** An event as a model reads it: its line, plus a few typed fields; never the plugin's `data`. */
export function eventRow(e: ApiEvent) {
  return {
    id: e.id,
    type: e.type,
    account: e.account.name,
    occurred_at: e.occurredAt,
    ...(e.valueGp !== null ? { value_gp: e.valueGp, value: gp(e.valueGp) } : {}),
    line: e.line,
  };
}

function itemRows(items: readonly ApiItem[]) {
  return items.map((i) => ({
    ...(i.equipmentSlot !== null ? { slot: i.equipmentSlot.toLowerCase() } : {}),
    name: i.name ?? `item ${i.id}`,
    ...(i.quantity !== 1 ? { quantity: i.quantity } : {}),
  }));
}

/** Inventory items merged by name (the API lists one per slot), most valuable stack first. */
function mergedInventory(items: readonly ApiItem[]) {
  const byName = new Map<string, { name: string; quantity: number; value: number }>();
  for (const i of items) {
    const name = i.name ?? `item ${i.id}`;
    const entry = byName.get(name) ?? { name, quantity: 0, value: 0 };
    entry.quantity += i.quantity;
    entry.value += i.quantity * i.gePrice;
    byName.set(name, entry);
  }
  return [...byName.values()]
    .sort((a, b) => b.value - a.value)
    .map((i) => ({ name: i.name, ...(i.quantity !== 1 ? { quantity: i.quantity } : {}) }));
}

// ---------------------------------------------------------------------------------------------
// The tools.

const listAccounts = tool({
  name: 'list_accounts',
  title: 'List accounts',
  description:
    'The accounts this key can see: name, id, account type, owner, whether they are online (needs "activity"), their world and when they were last seen, and which categories the key may read on each. REST: GET /api/v1/accounts.',
  input: {
    online: z
      .boolean()
      .optional()
      .describe('true: only accounts in game now; false: only offline.'),
    names: z.array(z.string().min(1).max(64)).max(50).optional().describe('Only these names.'),
  },
  async run(ctx, args) {
    const [list, categories] = await Promise.all([
      apiListAccounts(
        ctx.db,
        ctx.principal,
        {
          ...(args.names !== undefined ? { names: args.names } : {}),
          ...(args.online !== undefined ? { online: args.online } : {}),
        },
        ctx.now,
      ),
      apiAccountCategories(ctx.db, ctx.principal),
    ]);
    const { items, truncated } = capped(list);
    const online = list.filter((a) => a.online === true);
    const worlds = [...new Set(online.map((a) => a.world).filter((w) => w !== null))];
    const summary =
      `${plural(list.length, 'account')}` +
      (online.length > 0
        ? `, ${online.length} online${worlds.length > 0 ? ` (world ${worlds.join(', ')})` : ''}`
        : list.some((a) => a.online === false)
          ? ', none online'
          : '');
    return result(
      summary,
      {
        accounts: items.map((a) => ({
          name: a.name,
          id: a.id,
          type: a.typeLabel,
          owner: a.owner?.name ?? null,
          online: a.online,
          world: a.world,
          last_seen: a.lastSeen,
          categories: categories.get(a.id) ?? [],
        })),
        truncated,
      },
      ctx.now,
    );
  },
});

const ACCOUNT_SECTIONS = ['stats', 'presence', 'equipment', 'inventory', 'wealth'] as const;

const getAccount = tool({
  name: 'get_account',
  title: 'Get an account',
  description:
    'One account now: levels ("stats"), online and world ("presence", needs "activity"), worn gear ("equipment"), inventory ("inventory") and wealth now (bank + inventory + gear, needs "inventory"; for how it changed over time use the wealth tool). Only the sections asked for; default stats and presence. Levels only, unless detail is true. REST: GET /api/v1/accounts/{id} and /accounts/{id}/wealth.',
  input: {
    account,
    sections: z.array(z.enum(ACCOUNT_SECTIONS)).min(1).max(5).optional(),
    detail: z.boolean().optional().describe("Also each skill's XP."),
  },
  async run(ctx, args) {
    const who = await resolveAccount(ctx.db, ctx.principal, args.account);
    const d = await apiGetAccount(ctx.db, ctx.principal, who.id, ctx.now);
    if (!d) throw notShared(who, 'data', 'stats');
    const wanted = new Set(args.sections ?? ['stats', 'presence']);
    const out: Record<string, unknown> = {
      account: d.name,
      id: d.id,
      type: d.typeLabel,
      owner: d.owner?.name ?? null,
      categories: d.categories,
    };
    const parts: string[] = [];
    const unavailable = (category: Category) =>
      `not readable with this key (needs "${category}", shared by the owner)`;
    const notSent = "the player doesn't send this from the plugin";

    if (wanted.has('stats')) {
      const s = d.skills;
      if (!s) out.stats = unavailable('stats');
      else if (!s.shared) out.stats = notSent;
      else {
        const skills = s.skills.filter((k) => k.skill !== 'Overall');
        out.stats = {
          total_level: s.totalLevel,
          overall_xp: s.overallXp,
          overall: compact(s.overallXp),
          ...(args.detail === true
            ? { skills: skills.map((k) => ({ skill: k.skill, level: k.level, xp: k.xp })) }
            : { levels: Object.fromEntries(skills.map((k) => [k.skill, k.level])) }),
          updated_at: s.updatedAt,
        };
        parts.push(`total level ${s.totalLevel}`);
      }
    }
    if (wanted.has('presence')) {
      const p = d.presence;
      if (!p) out.presence = unavailable('activity');
      else if (!p.shared) out.presence = notSent;
      else {
        const v = d.vitals?.shared ? d.vitals : null;
        out.presence = {
          online: p.online,
          world: p.world,
          last_seen: p.lastSeen,
          ...(v?.activePrayers && v.activePrayers.length > 0
            ? { active_prayers: v.activePrayers }
            : {}),
        };
        parts.push(
          p.online ? `online on world ${p.world ?? '?'}` : `offline, last seen ${p.lastSeen}`,
        );
      }
    }
    if (wanted.has('equipment')) {
      const e = d.equipment;
      if (!e) out.equipment = unavailable('equipment');
      else if (!e.shared) out.equipment = notSent;
      else {
        out.equipment = { items: itemRows(e.items), value_gp: e.value, value: gp(e.value) };
        parts.push(`gear worth ${gp(e.value)}`);
      }
    }
    if (wanted.has('inventory')) {
      const i = d.inventory;
      if (!i) out.inventory = unavailable('inventory');
      else if (!i.shared) out.inventory = notSent;
      else {
        out.inventory = { items: mergedInventory(i.items), value_gp: i.value, value: gp(i.value) };
        parts.push(`inventory worth ${gp(i.value)}`);
      }
    }
    if (wanted.has('wealth')) {
      const w = await apiWealth(
        ctx.db,
        ctx.principal,
        who.id,
        { from: new Date(ctx.now.getTime() - 30 * DAY_MS), to: ctx.now },
        ctx.now,
      );
      const last = w?.days.at(-1);
      if (!w) out.wealth = unavailable('inventory');
      else if (!last) out.wealth = 'no wealth reading in the last 30 days';
      else {
        out.wealth = {
          day: last.day,
          total_gp: last.lastValue,
          total: gp(last.lastValue),
          bank_gp: last.bankValue,
          bank: gp(last.bankValue),
        };
        parts.push(`worth ${gp(last.lastValue)}`);
      }
    }
    return result(`${d.name}${parts.length > 0 ? `: ${parts.join(', ')}` : ''}`, out, ctx.now);
  },
});

const getGains = tool({
  name: 'get_gains',
  title: 'XP gained',
  description:
    'XP an account gained per skill in a period (day = since midnight in your time zone, week/month/year = the last 7/30/365 days) or between from and to. Only skills with a gain, most first. Needs "stats". REST: GET /api/v1/accounts/{id}/gains.',
  input: {
    account,
    period: z.enum(GAINS_PERIODS).optional(),
    from: when.optional(),
    to: when.optional(),
  },
  async run(ctx, args) {
    const who = await resolveAccount(ctx.db, ctx.principal, args.account);
    const span = range(args, ctx.now);
    const g = await apiGains(
      ctx.db,
      ctx.principal,
      who.id,
      { ...(args.period !== undefined ? { period: args.period } : {}), ...span },
      ctx.now,
    );
    if (!g) throw notShared(who, 'XP', 'stats');
    const total = g.gains.find((s) => s.skill === 'Overall')?.xp ?? 0;
    const skills = g.gains
      .filter((s) => s.skill !== 'Overall' && s.xp > 0)
      .sort((a, b) => b.xp - a.xp)
      .map((s) => ({ skill: s.skill, xp: s.xp, gained: compact(s.xp) }));
    const top = skills
      .slice(0, 3)
      .map((s) => `${s.skill} ${s.gained}`)
      .join(', ');
    return result(
      total > 0
        ? `${who.name} gained ${compact(total)} XP${g.period ? ` (${g.period})` : ''}: ${top}`
        : `${who.name} gained no XP${g.period ? ` (${g.period})` : ''}`,
      { account: who.name, period: g.period, from: g.from, to: g.to, total_xp: total, skills },
      ctx.now,
    );
  },
});

const EVENT_TYPES =
  'loot, pk_loot, death, level_up, collection_log, superior_spawn, achievement_diary, combat_task';

const eventInputs = {
  types: z
    .array(z.string().min(1).max(40))
    .max(20)
    .optional()
    .describe(`Only these: ${EVENT_TYPES}.`),
  accounts: accounts.optional(),
  min_value: z.number().int().min(0).optional().describe('Only drops worth at least this many GP.'),
  from: when.optional().describe('Default: 30 days before `to`.'),
  to: when.optional().describe('Default: now.'),
  limit: z.number().int().min(1).max(MCP_LIST_CAP).optional().describe('Default 20.'),
  cursor: z
    .string()
    .max(200)
    .optional()
    .describe('next_cursor of an earlier call, for older events.'),
};

async function events(
  ctx: ToolContext,
  args: z.infer<z.ZodObject<typeof eventInputs>> & { item?: string; npc?: string },
): Promise<ToolResult> {
  const ids = await accountIds(ctx, args.accounts);
  const page = await apiEventsInRange(
    ctx.db,
    ctx.principal,
    {
      ...range(args, ctx.now),
      limit: args.limit ?? 20,
      ...(args.types !== undefined ? { types: args.types } : {}),
      ...(ids !== undefined ? { accountIds: ids } : {}),
      ...(args.min_value !== undefined ? { minValue: args.min_value } : {}),
      ...(args.item !== undefined ? { item: args.item } : {}),
      ...(args.npc !== undefined ? { npc: args.npc } : {}),
      ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
    },
    ctx.now,
  );
  const rows = page.events.map(eventRow);
  const newest = rows[0];
  return result(
    rows.length === 0
      ? 'No events match'
      : `${plural(rows.length, 'event')}, newest first${newest ? `; latest: ${newest.line}` : ''}`,
    { events: rows, next_cursor: page.nextCursor },
    ctx.now,
  );
}

const recentEvents = tool({
  name: 'recent_events',
  title: 'Recent events',
  description: `Drops, deaths, level-ups, collection log slots and other events, newest first, from the accounts whose "events" the key reads. Each has a one-line description. Page with next_cursor. REST: GET /api/v1/events?from=&to=.`,
  input: eventInputs,
  async run(ctx, args) {
    return events(ctx, args);
  },
});

const search = z.string().min(2).max(64);

const searchEvents = tool({
  name: 'search_events',
  title: 'Search events',
  description:
    'Events by item or NPC name, newest first: "when did X last get a Zulrah drop" is npc=zulrah, accounts=[X], types=[loot]. item matches any item of a drop, npc the source of a drop, the killer of a death, or a superior. Part of a name, any case. Needs "events". REST: GET /api/v1/events?item=&npc=.',
  input: {
    item: search.optional().describe('Part of an item name, 2 to 64 characters.'),
    npc: search.optional().describe('Part of an NPC name, 2 to 64 characters.'),
    ...eventInputs,
  },
  async run(ctx, args) {
    if (args.item === undefined && args.npc === undefined) {
      throw new ToolError(
        'Give item or npc (or both); recent_events lists events without a search.',
      );
    }
    return events(ctx, args);
  },
});

const leaderboard = tool({
  name: 'leaderboard',
  title: 'Leaderboard',
  description:
    'The guild\'s leaderboards: kind=gains is XP gained per skill (Overall and every skill anyone trained, or one skill), kind=loot the most valuable drops, kind=kills boss kills gained per boss (from the hiscores; week or month only). day = since midnight in your time zone, week/month = the last 7/30 days. Over the accounts whose "stats" (gains), "events" (loot) or "hiscores" (kills) the key reads. REST: GET /api/v1/leaderboards/gains, /leaderboards/loot and /leaderboards/kills.',
  input: {
    kind: z.enum(['gains', 'loot', 'kills']),
    skill: z.string().min(1).max(40).optional().describe('gains only: one skill, e.g. "Slayer".'),
    boss: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe('kills only: one boss as the hiscores name it, e.g. "Zulrah".'),
    period: z
      .enum(LEADERBOARD_PERIODS)
      .optional()
      .describe('Default day (week for kills, which has no day).'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MCP_LIST_CAP)
      .optional()
      .describe('Rows per board: default 10 (gains with every skill: 3).'),
  },
  async run(ctx, args) {
    if (args.kind === 'kills') return killsBoard(ctx, args);
    const period = args.period ?? 'day';
    if (args.kind === 'loot') {
      const l = await apiLootLeaderboard(
        ctx.db,
        ctx.principal,
        { period, limit: args.limit ?? 10 },
        ctx.now,
      );
      const top = l.entries[0];
      return result(
        top ? `Biggest drop (${period}): ${top.event.line}` : `No drops with a value (${period})`,
        {
          kind: 'loot',
          period,
          from: l.from,
          to: l.to,
          entries: l.entries.map((e) => ({ rank: e.rank, ...eventRow(e.event) })),
        },
        ctx.now,
      );
    }
    const l = await apiLeaderboardGains(
      ctx.db,
      ctx.principal,
      { period, ...(args.skill !== undefined ? { skill: args.skill } : {}) },
      ctx.now,
    );
    const rows = args.limit ?? (args.skill !== undefined ? 10 : 3);
    const boards = l.leaderboards.slice(0, MCP_LIST_CAP).map((b) => ({
      skill: b.skill,
      entries: b.entries.slice(0, rows).map((e) => ({
        rank: e.rank,
        account: e.account.name,
        xp: e.gain,
        gained: compact(e.gain),
      })),
    }));
    const first = boards[0];
    const leader = first?.entries[0];
    return result(
      leader
        ? `${first.skill} (${period}): ${leader.account} leads with ${leader.gained} XP`
        : `Nobody gained XP${args.skill !== undefined ? ` in ${args.skill}` : ''} (${period})`,
      { kind: 'gains', period, from: l.from, to: l.to, boards },
      ctx.now,
    );
  },
});

const HISCORE_FIELDS = ['bosses', 'clues', 'minigames', 'skills'] as const;

function hiscoresRow(h: ApiHiscores, fields: ReadonlySet<string>) {
  const out: Record<string, unknown> = {
    account: h.account.name,
    status: h.status,
    mode: h.mode,
    read_at: h.fetchedAt,
  };
  const activities = (kind: 'boss' | 'clue' | 'activity') =>
    h.activities
      .filter((a) => a.kind === kind)
      .sort((a, b) => b.score - a.score)
      .slice(0, MCP_LIST_CAP)
      .map((a) => ({ name: a.activity, score: a.score, rank: a.rank }));
  if (fields.has('skills')) {
    out.skills = h.skills.map((s) => ({ skill: s.skill, level: s.level, xp: s.xp, rank: s.rank }));
  }
  if (fields.has('bosses')) out.bosses = activities('boss');
  if (fields.has('clues')) out.clues = activities('clue');
  if (fields.has('minigames')) out.minigames = activities('activity');
  return out;
}

const getHiscores = tool({
  name: 'get_hiscores',
  title: 'Hiscores',
  description:
    'The official hiscores as the hub last read them: boss kill counts (most first), clue scrolls, minigames and skills with ranks. Needs "hiscores". At most 10 accounts per call (50 with a service key). REST: GET /api/v1/hiscores?accounts=.',
  input: {
    accounts: z.array(account).min(1).max(50),
    fields: z.array(z.enum(HISCORE_FIELDS)).min(1).max(4).optional().describe('Default all four.'),
  },
  async run(ctx, args) {
    const ids = (await accountIds(ctx, args.accounts)) ?? [];
    const list = await apiHiscoresMulti(ctx.db, ctx.principal, { ids });
    const fields = new Set<string>(args.fields ?? HISCORE_FIELDS);
    const rows = list.map((h) => hiscoresRow(h, fields));
    const first = list[0];
    const topBoss = first?.activities
      .filter((a) => a.kind === 'boss')
      .sort((a, b) => b.score - a.score)[0];
    return result(
      list.length === 1 && first
        ? first.status === 'pending'
          ? `${first.account.name}'s hiscores haven't been read yet`
          : `${first.account.name}: total level ${first.skills[0]?.level ?? '?'}${topBoss ? `, most kills: ${topBoss.activity} ${topBoss.score}` : ''}`
        : `Hiscores of ${plural(list.length, 'account')}`,
      { accounts: rows },
      ctx.now,
    );
  },
});

function slotLine(s: {
  item: string;
  killCount: number | null;
  source: string | null;
  at: string;
}) {
  return `${s.item}${s.killCount !== null ? ` (kc ${s.killCount})` : ''}${s.source !== null ? ` from ${s.source}` : ''} on ${day(s.at)}`;
}

const collectionLog = tool({
  name: 'collection_log',
  title: 'Collection log',
  description:
    'One account\'s collection log: the total from the hiscores (needs "hiscores") and the slots the hub saw logged (needs "events"), newest first, with the source and kill count, plus counts per source. REST: GET /api/v1/accounts/{id}/collection-log.',
  input: {
    account,
    source: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe('Only slots from this source, e.g. "Zulrah".'),
    since: when.optional(),
    limit: z.number().int().min(1).max(MCP_LIST_CAP).optional().describe('Slots; default 20.'),
  },
  async run(ctx, args) {
    const who = await resolveAccount(ctx.db, ctx.principal, args.account);
    const log = await apiAccountCollectionLog(
      ctx.db,
      ctx.principal,
      who.id,
      {
        limit: args.limit ?? 20,
        ...(args.source !== undefined ? { source: args.source } : {}),
        ...(args.since !== undefined ? { since: parseWhen(args.since, 'from', ctx.now) } : {}),
      },
      ctx.now,
    );
    if (!log) throw notShared(who, 'collection log', 'events');
    const t = log.total;
    const seen = log.groups?.reduce((n, g) => n + g.count, 0) ?? null;
    const summary = [
      t?.logged != null ? `${who.name} has ${t.logged} collection log slots` : who.name,
      seen !== null
        ? `the hub saw ${plural(seen, 'slot')} logged${args.source ? ` from ${args.source}` : ''}`
        : null,
      log.slots?.[0] ? `latest: ${slotLine(log.slots[0])}` : null,
    ]
      .filter((p) => p !== null)
      .join('; ');
    return result(
      summary,
      {
        account: who.name,
        total:
          t === null
            ? 'not readable with this key (needs "hiscores")'
            : { logged: t.logged, rank: t.rank, gained_30_days: t.gained30, read_at: t.fetchedAt },
        slots:
          log.slots === null
            ? 'not readable with this key (needs "events")'
            : log.slots.map(slotLine),
        by_source:
          log.groups === null
            ? null
            : capped(log.groups).items.map((g) => ({
                source: g.source ?? 'unknown',
                count: g.count,
              })),
        truncated: log.truncated,
      },
      ctx.now,
    );
  },
});

const whoHas = tool({
  name: 'who_has',
  title: 'Who has an item',
  description:
    'Who in the guild logged an item in their collection log, and when, first first. Matches part of an item name, any case. Only accounts whose "events" the key reads are searched: `searchable` says how many, so you can say "of the 23 accounts that share their log". The hub only knows slots logged since its plugin ran. REST: GET /api/v1/collection-log?item=.',
  input: {
    item: z.string().min(2).max(64).describe('Part of an item name, e.g. "shadow".'),
    accounts: accounts.optional(),
  },
  async run(ctx, args) {
    const ids = await accountIds(ctx, args.accounts);
    const log = await apiGuildCollectionLog(
      ctx.db,
      ctx.principal,
      { item: args.item, limit: 1, ...(ids !== undefined ? { accounts: ids } : {}) },
      ctx.now,
    );
    const items = capped(log.items ?? []);
    const rows = items.items.map((i) => ({
      item: i.item,
      holders: capped(i.holders).items.map((h) => ({
        account: h.account.name,
        logged_at: h.at,
        kill_count: h.killCount,
      })),
      holder_count: i.holders.length,
    }));
    const holders = new Set(rows.flatMap((r) => r.holders.map((h) => h.account)));
    const of = `of ${plural(log.searchable, 'account')} that share their log`;
    return result(
      rows.length === 0
        ? `Nobody ${of} has logged an item matching "${args.item}"`
        : rows.length === 1
          ? `${plural(holders.size, 'account')} ${of} logged ${rows[0]!.item}: ${[...holders].join(', ')}`
          : `${rows.length} items match "${args.item}"; ${plural(holders.size, 'account')} ${of} logged one`,
      { items: rows, searchable: log.searchable, truncated: items.truncated },
      ctx.now,
    );
  },
});

const sessions = tool({
  name: 'sessions',
  title: 'Play sessions',
  description:
    'When an account played: each session\'s start, end (or "ongoing"), length and worlds, newest first. Default the last 30 days. Needs "activity". REST: GET /api/v1/accounts/{id}/sessions.',
  input: { account, from: when.optional(), to: when.optional() },
  async run(ctx, args) {
    const who = await resolveAccount(ctx.db, ctx.principal, args.account);
    const s = await apiSessions(ctx.db, ctx.principal, who.id, range(args, ctx.now), ctx.now);
    if (!s) throw notShared(who, 'play sessions', 'activity');
    const total = s.sessions.reduce((ms, x) => ms + x.durationMs, 0);
    const list = capped([...s.sessions].sort((a, b) => b.startedAt.localeCompare(a.startedAt)));
    return result(
      `${who.name}: ${plural(s.sessions.length, 'session')}, ${minutes(total)} played between ${day(s.from)} and ${day(s.to)}`,
      {
        account: who.name,
        from: s.from,
        to: s.to,
        total_minutes: Math.round(total / 60_000),
        sessions: list.items.map((x) => ({
          start: x.startedAt,
          end: x.endedAt ?? 'ongoing',
          minutes: Math.round(x.durationMs / 60_000),
          worlds: x.worlds,
        })),
        truncated: list.truncated,
      },
      ctx.now,
    );
  },
});

const RAW_POINTS = 200;

const locations = tool({
  name: 'locations',
  title: 'Where an account went',
  description:
    'Where an account was, from its location trail (kept 30 days, default the last 24 hours). Summarised (default): stays per place ("Lumbridge", "Grand Exchange", "Wilderness (level 20)", as the live map names them) with minutes and how the player arrived (move, teleport, entrance, …), newest first, and the places where the most time went. summarise=false gives the last 200 points with their place and how each was reached. For a whole day, day_summary is one call. Needs "location_history". REST: GET /api/v1/accounts/{id}/locations.',
  input: {
    account,
    from: when.optional(),
    to: when.optional(),
    summarise: z.boolean().optional().describe('Default true.'),
  },
  async run(ctx, args) {
    const who = await resolveAccount(ctx.db, ctx.principal, args.account);
    const l = await apiLocations(ctx.db, ctx.principal, who.id, range(args, ctx.now), ctx.now);
    if (!l) throw notShared(who, 'location history', 'location_history');
    if (args.summarise === false) {
      const raw = l.points.slice(-RAW_POINTS);
      return result(
        `${who.name}: the last ${plural(raw.length, 'point')} between ${day(l.from)} and ${day(l.to)}`,
        {
          account: who.name,
          from: l.from,
          to: l.to,
          points: raw.map((p) => ({
            at: p.at,
            place: p.region,
            x: p.x,
            y: p.y,
            plane: p.plane,
            via: p.via,
          })),
          truncated: l.truncated || l.points.length > raw.length,
        },
        ctx.now,
      );
    }
    const all = placeStays(l.points);
    const places = placesOf(all);
    const teleports = all.filter((s) => s.arrivedBy === 'teleport').length;
    const list = capped([...all].reverse());
    const top = places[0];
    return result(
      all.length === 0
        ? `${who.name}: no location points between ${day(l.from)} and ${day(l.to)}`
        : `${who.name}: ${plural(all.length, 'stay')} in ${plural(places.length, 'place')}, ${plural(teleports, 'teleport')}; most time in ${top!.name} (${minutes(top!.ms)})`,
      {
        account: who.name,
        from: l.from,
        to: l.to,
        stays: list.items.map((s) => ({
          place: s.name,
          plane: s.plane,
          from: s.from,
          to: s.to,
          minutes: Math.round(s.ms / 60_000),
          arrived_by: s.arrivedBy,
        })),
        places: capped(places).items.map(placeRow),
        teleports,
        truncated: list.truncated || l.truncated,
      },
      ctx.now,
    );
  },
});

function placeRow(p: ApiPlace) {
  return { place: p.name, minutes: Math.round(p.ms / 60_000), visits: p.visits };
}

const localDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'a date: YYYY-MM-DD')
  .describe("A date, YYYY-MM-DD, in the time zone of the key's owner (UTC for a service key).");

const daySummary = tool({
  name: 'day_summary',
  title: 'What an account did on a day',
  description:
    "Everything about one account's day in one call: how long it played (sessions), the XP it gained per skill, its events (counts per type, the most valuable drops, new collection log slots) and where it spent its time (named places with minutes and visits). Give date for one day (default today), or from and to for up to 7 days. Dates are in the time zone of the key's owner. Parts the key can't read are left out and named in not_shared. Use this for \"what did X do today / yesterday / this weekend\". REST: GET /api/v1/accounts/{id}/day.",
  input: {
    account,
    date: localDate.optional(),
    from: localDate.optional(),
    to: localDate.optional(),
  },
  async run(ctx, args) {
    const who = await resolveAccount(ctx.db, ctx.principal, args.account);
    const params = {
      ...(args.date !== undefined ? { date: args.date } : {}),
      ...(args.from !== undefined ? { from: args.from } : {}),
      ...(args.to !== undefined ? { to: args.to } : {}),
    };
    const d = await apiDay(ctx.db, ctx.principal, who.id, params, ctx.now);
    if (!d) {
      throw new ToolError(
        `This key can't read any of ${who.name}'s day: it needs "activity", "stats", "events" or "location_history", shared with you by the owner. hub://me lists what the key may read.`,
      );
    }
    const dates = d.dates.from === d.dates.to ? d.dates.from : `${d.dates.from} to ${d.dates.to}`;
    const hidden = (
      [
        ['sessions', 'activity'],
        ['gains', 'stats'],
        ['events', 'events'],
        ['places', 'location_history'],
      ] as const
    )
      .filter(([section]) => d[section] === undefined)
      .map(([section, category]) => `${section} (needs "${category}")`);
    const parts: string[] = [];
    if (d.sessions) parts.push(`played ${minutes(d.sessions.totalMs)}`);
    if (d.gains) parts.push(`gained ${compact(d.gains.total)} XP`);
    if (d.events) parts.push(plural(d.events.count, 'event'));
    if (d.places?.list[0]) parts.push(`most time in ${d.places.list[0].name}`);
    return result(
      `${who.name} on ${dates} (${d.timezone}): ${parts.join(', ') || 'nothing readable'}`,
      {
        account: who.name,
        timezone: d.timezone,
        dates: d.dates,
        from: d.from,
        to: d.to,
        ...(d.sessions && {
          sessions: {
            count: d.sessions.count,
            total_minutes: Math.round(d.sessions.totalMs / 60_000),
            list: capped(d.sessions.list).items.map((x) => ({
              start: x.startedAt,
              end: x.endedAt ?? 'ongoing',
              minutes: Math.round(x.durationMs / 60_000),
              worlds: x.worlds,
            })),
          },
        }),
        ...(d.gains && {
          gains: {
            total_xp: d.gains.total,
            total: compact(d.gains.total),
            skills: d.gains.skills.map((g) => ({ skill: g.skill, xp: g.xp })),
          },
        }),
        ...(d.events && {
          events: {
            count: d.events.count,
            by_type: d.events.byType,
            top: d.events.top.map(eventRow),
            collection_log: capped(d.events.collectionLog).items.map(eventRow),
            truncated: d.events.truncated,
          },
        }),
        ...(d.places && {
          places: {
            stays: d.places.stays,
            teleports: d.places.teleports,
            list: d.places.list.map(placeRow),
            truncated: d.places.truncated,
          },
        }),
        ...(hidden.length > 0 ? { not_shared: hidden } : {}),
      },
      ctx.now,
    );
  },
});

async function killsBoard(
  ctx: ToolContext,
  args: { boss?: string; period?: string; limit?: number },
): Promise<ToolResult> {
  const period = args.period ?? 'week';
  if (!(KILLS_LEADERBOARD_PERIODS as readonly string[]).includes(period)) {
    throw new ToolError(
      'Boss kills come from the hiscores, read after each session, so kills has week or month, not day.',
    );
  }
  const l = await apiKillsLeaderboard(
    ctx.db,
    ctx.principal,
    {
      period: period as (typeof KILLS_LEADERBOARD_PERIODS)[number],
      ...(args.boss !== undefined ? { boss: args.boss } : {}),
    },
    ctx.now,
  );
  const rows = args.limit ?? (args.boss !== undefined ? 10 : 3);
  const boards = l.leaderboards.slice(0, MCP_LIST_CAP).map((b) => ({
    boss: b.boss,
    entries: b.entries.slice(0, rows).map((e) => ({
      rank: e.rank,
      account: e.account.name,
      kills: e.kills,
    })),
  }));
  const first = boards[0];
  const leader = first?.entries[0];
  return result(
    leader
      ? `${first.boss} (${period}): ${leader.account} leads with ${plural(leader.kills, 'kill')}`
      : `Nobody gained boss kills${args.boss !== undefined ? ` at ${args.boss}` : ''} (${period}) on the hiscores`,
    {
      kind: 'kills',
      period,
      from: l.from,
      to: l.to,
      boards,
      truncated: l.leaderboards.length > MCP_LIST_CAP,
    },
    ctx.now,
  );
}

/** At most MCP_LIST_CAP of `list`, spread evenly, always keeping the first and the last. */
export function thinned<T>(list: readonly T[], cap = MCP_LIST_CAP): T[] {
  if (list.length <= cap) return [...list];
  const out: T[] = [];
  for (let i = 0; i < cap; i++) out.push(list[Math.round((i * (list.length - 1)) / (cap - 1))]!);
  return out;
}

const wealth = tool({
  name: 'wealth',
  title: 'Wealth over time',
  description:
    'How an account\'s wealth (bank + inventory + worn gear at Grand Exchange prices) went over time: the value now, at the start, the change, the highest and lowest day, and the value per UTC day. The bank counts from the first time the plugin read it (bank_gp null before). Default the last 30 days. Needs "inventory". REST: GET /api/v1/accounts/{id}/wealth.',
  input: {
    account,
    from: when.optional().describe('Default 30 days before `to`.'),
    to: when.optional(),
  },
  async run(ctx, args) {
    const who = await resolveAccount(ctx.db, ctx.principal, args.account);
    const w = await apiWealth(ctx.db, ctx.principal, who.id, range(args, ctx.now), ctx.now);
    if (!w) throw notShared(who, 'wealth', 'inventory');
    const first = w.days[0];
    const last = w.days.at(-1);
    if (!first || !last) {
      return result(
        `${who.name}: no wealth reading between ${day(w.from)} and ${day(w.to)} (the plugin sends one while logged in)`,
        { account: who.name, from: w.from, to: w.to, days: [] },
        ctx.now,
      );
    }
    const change = last.lastValue - first.lastValue;
    const high = w.days.reduce((a, b) => (b.maxValue > a.maxValue ? b : a));
    const low = w.days.reduce((a, b) => (b.lastValue < a.lastValue ? b : a));
    const days = thinned(w.days);
    return result(
      `${who.name} is worth ${gp(last.lastValue)} (${last.day}${last.bankValue !== null ? `, bank ${gp(last.bankValue)}` : ', bank not read yet'}): ${formatGpChange(change)} since ${first.day}`,
      {
        account: who.name,
        from: w.from,
        to: w.to,
        now: {
          day: last.day,
          total_gp: last.lastValue,
          total: gp(last.lastValue),
          bank_gp: last.bankValue,
          bank: gp(last.bankValue),
          carried_gp: last.lastValue - (last.bankValue ?? 0),
          carried: gp(last.lastValue - (last.bankValue ?? 0)),
        },
        start: { day: first.day, total_gp: first.lastValue, total: gp(first.lastValue) },
        change_gp: change,
        change: formatGpChange(change),
        highest: { day: high.day, total_gp: high.maxValue, total: gp(high.maxValue) },
        lowest: { day: low.day, total_gp: low.lastValue, total: gp(low.lastValue) },
        days: days.map((d) => ({
          day: d.day,
          total_gp: d.lastValue,
          total: gp(d.lastValue),
          bank_gp: d.bankValue,
        })),
        ...(days.length < w.days.length ? { thinned_from: w.days.length } : {}),
      },
      ctx.now,
    );
  },
});

const progress = tool({
  name: 'progress',
  title: 'Progress over a range',
  description:
    'An account\'s Progress page for a range, in one call: playtime (sessions, time online, active time, active time per day and "where the time goes" per activity; needs "activity" and "stats"), XP gained per skill with XP/h ("stats"), loot value ("events"), boss kill counts and kills gained ("hiscores"), the change in wealth ("inventory"), and the owner\'s goals. Sections the key can\'t read are named in not_shared. range: today, 7d (default), 30d, 90d or 1y; or from/to dates in the key owner\'s time zone. REST: GET /api/v1/accounts/{id}/progress.',
  input: {
    account,
    range: z.enum(PROGRESS_RANGES).optional().describe('Default 7d. Not with from/to.'),
    from: when.optional().describe('A custom range instead of `range`, with `to`.'),
    to: when.optional(),
  },
  async run(ctx, args) {
    const who = await resolveAccount(ctx.db, ctx.principal, args.account);
    const p = await apiProgress(
      ctx.db,
      ctx.principal,
      who.id,
      {
        ...(args.range !== undefined ? { range: args.range } : {}),
        ...(args.from !== undefined ? { from: args.from.trim() } : {}),
        ...(args.to !== undefined ? { to: args.to.trim() } : {}),
      },
      ctx.now,
    );
    if (!p) {
      throw new ToolError(
        `This key can't read ${who.name}'s progress: it needs one of "activity", "stats", "events", "hiscores" or "inventory", and the owner has to share it with you. hub://me lists what the key may read.`,
      );
    }
    const hidden = [
      ...(p.playtime ? [] : ['playtime (needs "activity" and "stats")']),
      ...(p.xp ? [] : ['xp (needs "stats")']),
      ...(p.loot ? [] : ['loot (needs "events")']),
      ...(p.bosses ? [] : ['bosses (needs "hiscores")']),
      ...(p.wealth ? [] : ['wealth (needs "inventory")']),
    ];
    const parts: string[] = [];
    if (p.playtime) {
      parts.push(
        `${minutes(p.playtime.onlineMs)} online (${minutes(p.playtime.activeMs)} active) over ${plural(p.playtime.sessions, 'session')}`,
      );
    }
    if (p.xp) parts.push(`${compact(p.xp.gained)} XP`);
    if (p.loot) parts.push(`${gp(p.loot.gp)} in drops`);
    if (p.bosses) parts.push(plural(p.bosses.kills, 'boss kill'));
    if (p.wealth && p.wealth.change !== null)
      parts.push(`wealth ${formatGpChange(p.wealth.change)}`);
    const activity = (a: { name: string; ms: number }) => ({
      name: a.name,
      minutes: Math.round(a.ms / 60_000),
    });
    return result(
      `${who.name}, ${day(p.from)} to ${day(p.to)}: ${parts.length > 0 ? parts.join(', ') : 'nothing recorded'}`,
      {
        account: who.name,
        range: p.range,
        from: p.from,
        to: p.to,
        timezone: p.timezone,
        ...(p.playtime && {
          playtime: {
            sessions: p.playtime.sessions,
            online_minutes: Math.round(p.playtime.onlineMs / 60_000),
            active_minutes: Math.round(p.playtime.activeMs / 60_000),
            online: minutes(p.playtime.onlineMs),
            active: minutes(p.playtime.activeMs),
            longest_session_minutes:
              p.playtime.longestMs === null ? null : Math.round(p.playtime.longestMs / 60_000),
            where_the_time_goes: p.playtime.activities.map(activity),
            days: capped(
              [...p.playtime.days].reverse().map((d) => ({
                date: d.date,
                active_minutes: Math.round(d.activeMs / 60_000),
                top: d.activities.slice(0, 3).map(activity),
              })),
            ).items,
          },
        }),
        ...(p.xp && {
          xp: {
            gained: p.xp.gained,
            total: compact(p.xp.gained),
            skills: p.xp.skills
              .filter((s) => s.gained > 0)
              .map((s) => ({
                skill: s.skill,
                level: s.level,
                gained: s.gained,
                ...(s.xpPerHour !== null ? { xp_per_hour: s.xpPerHour } : {}),
              })),
          },
        }),
        ...(p.loot && { loot: { value_gp: p.loot.gp, value: gp(p.loot.gp), drops: p.loot.drops } }),
        ...(p.bosses && {
          bosses: {
            kills_gained: p.bosses.kills,
            read_at: p.bosses.readAt,
            list: capped(p.bosses.list).items.map((b) => ({
              boss: b.boss,
              kill_count: b.killCount,
              gained: b.gained,
              ...(b.gp !== null && b.gp > 0 ? { loot: gp(b.gp) } : {}),
            })),
          },
        }),
        ...(p.wealth && {
          wealth: {
            change_gp: p.wealth.change,
            change: p.wealth.change === null ? null : formatGpChange(p.wealth.change),
          },
        }),
        ...(p.goals.length > 0 && {
          goals: p.goals.map((g) => ({
            goal: `${g.kind === 'kc' ? `${g.value} ${g.target} kills` : g.kind === 'level' ? `${g.target} level ${g.value}` : `${compact(g.value)} ${g.target} XP`}`,
            progress: g.progress === null ? null : `${Math.round(g.progress * 100)}%`,
            ...(g.etaDays !== null ? { days_to_go: Math.round(g.etaDays) } : {}),
          })),
        }),
        ...(hidden.length > 0 ? { not_shared: hidden } : {}),
      },
      ctx.now,
    );
  },
});

const gearHistory = tool({
  name: 'gear_history',
  title: 'Gear by trip',
  description:
    'What an account wore, as trips (the hub\'s gear history): changes less than 20 minutes apart that share at least two items are one trip, with its start, end, number of swaps and setups, and the kit per slot, the longest worn first. Newest first. Default the last 7 days. Needs "equipment". REST: GET /api/v1/accounts/{id}/equipment-history (the raw changes).',
  input: {
    account,
    from: when.optional().describe('Default 7 days before `to`.'),
    to: when.optional(),
  },
  async run(ctx, args) {
    const who = await resolveAccount(ctx.db, ctx.principal, args.account);
    const r = range(args, ctx.now);
    const h = await apiEquipmentHistory(
      ctx.db,
      ctx.principal,
      who.id,
      { from: r.from ?? new Date((r.to ?? ctx.now).getTime() - 7 * DAY_MS), ...r },
      ctx.now,
    );
    if (!h) throw notShared(who, 'gear', 'equipment');
    const trips = gearTrips(
      h.changes.map((c) => ({
        changedAt: c.changedAt,
        items: c.items.map((i) => ({
          id: i.id,
          gePrice: i.gePrice,
          quantity: i.quantity,
          ...(i.name !== null ? { name: i.name } : {}),
          ...(i.equipmentSlot !== null ? { equipmentSlot: i.equipmentSlot } : {}),
        })),
      })),
      new Date(Math.min(Date.parse(h.to), ctx.now.getTime())),
    );
    const list = capped(trips);
    return result(
      `${who.name}: ${plural(trips.length, 'trip')} with gear changes between ${day(h.from)} and ${day(h.to)}`,
      {
        account: who.name,
        from: h.from,
        to: h.to,
        trips: list.items.map((t) => ({
          start: t.startedAt,
          end: t.endedAt,
          swaps: t.swaps,
          setups: t.setups,
          kit: Object.fromEntries(
            t.kit.map((k) => [k.slot.toLowerCase(), k.items.map((i) => i.name ?? `item ${i.id}`)]),
          ),
        })),
        truncated: list.truncated,
      },
      ctx.now,
    );
  },
});

/** Every tool, in the order tools/list gives them. */
export const TOOLS: readonly ToolDef[] = [
  listAccounts,
  getAccount,
  getGains,
  recentEvents,
  searchEvents,
  leaderboard,
  getHiscores,
  collectionLog,
  whoHas,
  sessions,
  locations,
  daySummary,
  wealth,
  progress,
  gearHistory,
];

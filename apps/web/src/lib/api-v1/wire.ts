/**
 * The @hub/server read models (camelCase) → the /api/v1 wire format (snake_case for every key the hub
 * defines, D-77). One explicit mapper per type, each returning `z.infer` of its response schema
 * (schemas.ts), so `tsc` catches drift between the docs and what the routes send. Never a generic
 * key converter: some keys are data — skill names ("Attack"), equipment slots, item and account
 * names — and an event's `data` object passes through exactly as the hub stored it.
 *
 * Omitted vs null matters (/accounts/{id}, /snapshot): a field the key's categories don't cover is
 * left out, a readable field the plugin never sent is null or `{ shared: false }`. The mappers keep
 * that distinction: they copy a field only when the read model has it.
 */
import type {
  ApiAccountDetail,
  ApiAccountSummary,
  ApiEquipment,
  ApiEquipmentHistory,
  ApiEvent,
  ApiGains,
  ApiInventory,
  ApiItem,
  ApiLeaderboards,
  ApiLocation,
  ApiLocations,
  ApiLocationsMulti,
  ApiMe,
  ApiOwner,
  ApiPresence,
  ApiSection,
  ApiSessions,
  ApiSkills,
  ApiSnapshotAccount,
  ApiVitals,
  ApiWealth,
  ApiXpMulti,
  ApiXpSeries,
} from '@hub/server';
import type {
  WireAccountDetail,
  WireAccountSummary,
  WireEquipmentHistory,
  WireEvent,
  WireGains,
  WireItem,
  WireLeaderboards,
  WireLocations,
  WireLocationsMulti,
  WireMe,
  WireOwner,
  WireSessions,
  WireSkills,
  WireSnapshotAccount,
  WireWealth,
  WireXpMulti,
  WireXpSeries,
} from './schemas';

type Section<W> = ({ shared: true; updated_at: string } & W) | { shared: false; updated_at: null };

function section<T extends object, W extends object>(
  s: ApiSection<T>,
  map: (data: T) => W,
): Section<W> {
  if (!s.shared) return { shared: false, updated_at: null };
  return { shared: true, updated_at: s.updatedAt, ...map(s as T) };
}

export function wireItem(item: ApiItem): WireItem {
  return {
    id: item.id,
    name: item.name,
    quantity: item.quantity,
    ge_price: item.gePrice,
    ha_price: item.haPrice,
    equipment_slot: item.equipmentSlot,
    inventory_slot: item.inventorySlot,
  };
}

function wireItems(items: ApiEquipment | ApiInventory): { items: WireItem[]; value: number } {
  return { items: items.items.map(wireItem), value: items.value };
}

/** Skill names are data: `skill` is copied as the plugin spells it. */
function wireSkills(skills: ApiSkills): WireSkills {
  return {
    total_level: skills.totalLevel,
    overall_xp: skills.overallXp,
    skills: skills.skills.map((s) => ({
      skill: s.skill,
      level: s.level,
      real_level: s.realLevel,
      xp: s.xp,
    })),
  };
}

function wirePresence(p: ApiPresence) {
  return {
    online: p.online,
    world: p.world,
    special_world: p.specialWorld,
    game_state: p.gameState,
    last_seen: p.lastSeen,
  };
}

function wireVitals(v: ApiVitals) {
  return { hp: v.hp, prayer: v.prayer, spellbook: v.spellbook };
}

function wireLocation(l: ApiLocation) {
  return { x: l.x, y: l.y, plane: l.plane, is_on_boat: l.isOnBoat, stale: l.stale };
}

export function wireMe(me: ApiMe): WireMe {
  return {
    key: {
      id: me.key.id,
      kind: me.key.kind,
      name: me.key.name,
      prefix: me.key.prefix,
      categories: me.key.categories,
      account_scope: me.key.accountScope,
      rate_limit_per_minute: me.key.rateLimitPerMinute,
      expires_at: me.key.expiresAt,
    },
    user: me.user === null ? null : { name: me.user.name },
    visible_accounts: me.visibleAccounts,
  };
}

function wireOwner(owner: ApiOwner | null): WireOwner | null {
  return owner === null ? null : { name: owner.name, discord_id: owner.discordId };
}

/** `account_hash` only when the read model has it (service keys, D-90): omitted, never null. */
function accountHash(a: { accountHash?: string }): { account_hash?: string } {
  return a.accountHash === undefined ? {} : { account_hash: a.accountHash };
}

export function wireAccountSummary(a: ApiAccountSummary): WireAccountSummary {
  return {
    id: a.id,
    name: a.name,
    ...accountHash(a),
    type: a.type,
    type_label: a.typeLabel,
    owner: wireOwner(a.owner),
    online: a.online,
    world: a.world,
    last_seen: a.lastSeen,
  };
}

export function wireAccountDetail(d: ApiAccountDetail): WireAccountDetail {
  const out: WireAccountDetail = {
    id: d.id,
    name: d.name,
    ...accountHash(d),
    type: d.type,
    type_label: d.typeLabel,
    owner: wireOwner(d.owner),
    first_seen: d.firstSeen,
    categories: d.categories,
  };
  if (d.presence) out.presence = section(d.presence, wirePresence);
  if (d.vitals) out.vitals = section(d.vitals, wireVitals);
  if (d.skills) out.skills = section(d.skills, wireSkills);
  if (d.location) out.location = section(d.location, wireLocation);
  if (d.equipment) out.equipment = section(d.equipment, wireItems);
  if (d.inventory) out.inventory = section(d.inventory, wireItems);
  return out;
}

export function wireSnapshotAccount(a: ApiSnapshotAccount): WireSnapshotAccount {
  const out: WireSnapshotAccount = {
    id: a.id,
    name: a.name,
    ...accountHash(a),
    type: a.type,
    type_label: a.typeLabel,
    owner: wireOwner(a.owner),
    categories: a.categories,
  };
  if (a.online !== undefined) out.online = a.online;
  if (a.world !== undefined) out.world = a.world;
  if (a.specialWorld !== undefined) out.special_world = a.specialWorld;
  if (a.lastSeen !== undefined) out.last_seen = a.lastSeen;
  if (a.hp !== undefined) out.hp = a.hp;
  if (a.prayer !== undefined) out.prayer = a.prayer;
  if (a.spellbook !== undefined) out.spellbook = a.spellbook;
  if (a.location !== undefined) {
    out.location = a.location && { ...wireLocation(a.location), updated_at: a.location.updatedAt };
  }
  if (a.skills !== undefined) out.skills = a.skills && wireSkills(a.skills);
  if (a.equipment !== undefined) out.equipment = a.equipment && wireItems(a.equipment);
  if (a.inventory !== undefined) out.inventory = a.inventory && wireItems(a.inventory);
  return out;
}

export function wireXpSeries(s: ApiXpSeries): WireXpSeries {
  return {
    account: { id: s.account.id, name: s.account.name },
    resolution: s.resolution,
    from: s.from,
    to: s.to,
    series: s.series.map((line) => ({
      skill: line.skill,
      points: line.points.map(([at, xp]): [string, number] => [at, xp]),
    })),
  };
}

export function wireXpMulti(m: ApiXpMulti): WireXpMulti {
  return {
    resolution: m.resolution,
    from: m.from,
    to: m.to,
    accounts: m.accounts.map(wireXpSeries),
  };
}

export function wireGains(g: ApiGains): WireGains {
  return {
    account: { id: g.account.id, name: g.account.name },
    period: g.period,
    from: g.from,
    to: g.to,
    gains: g.gains.map((x) => ({ skill: x.skill, xp: x.xp })),
  };
}

/**
 * The stored event is always an object (the plugin's event from the raw payload, D-31); anything
 * else would be a storage bug, sent as an empty object rather than breaking the documented type.
 */
function eventData(data: unknown): Record<string, unknown> {
  return typeof data === 'object' && data !== null && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : {};
}

export function wireEvent(e: ApiEvent): WireEvent {
  return {
    id: e.id,
    type: e.type,
    account: { id: e.account.id, name: e.account.name },
    occurred_at: e.occurredAt,
    received_at: e.receivedAt,
    value_gp: e.valueGp,
    item_id: e.itemId,
    npc_id: e.npcId,
    skill: e.skill,
    level: e.level,
    tier: e.tier,
    points: e.points,
    special_world: e.specialWorld,
    data: eventData(e.data),
    title: e.title,
    line: e.line,
  };
}

export function wireSessions(h: ApiSessions): WireSessions {
  return {
    account: { id: h.account.id, name: h.account.name },
    from: h.from,
    to: h.to,
    sessions: h.sessions.map((s) => ({
      id: s.id,
      started_at: s.startedAt,
      ended_at: s.endedAt,
      last_seen_at: s.lastSeenAt,
      duration_ms: s.durationMs,
      worlds: s.worlds,
      end_reason: s.endReason,
    })),
  };
}

export function wireEquipmentHistory(h: ApiEquipmentHistory): WireEquipmentHistory {
  return {
    account: { id: h.account.id, name: h.account.name },
    from: h.from,
    to: h.to,
    changes: h.changes.map((c) => ({ changed_at: c.changedAt, items: c.items.map(wireItem) })),
  };
}

export function wireWealth(h: ApiWealth): WireWealth {
  return {
    account: { id: h.account.id, name: h.account.name },
    from: h.from,
    to: h.to,
    days: h.days.map((d) => ({ day: d.day, last_value: d.lastValue, max_value: d.maxValue })),
  };
}

function wireLocationPoints(points: ApiLocations['points']): WireLocations['points'] {
  return points.map((p) => ({
    at: p.at,
    x: p.x,
    y: p.y,
    plane: p.plane,
    world: p.world,
    is_on_boat: p.isOnBoat,
  }));
}

export function wireLocations(h: ApiLocations): WireLocations {
  return {
    account: { id: h.account.id, name: h.account.name },
    from: h.from,
    to: h.to,
    points: wireLocationPoints(h.points),
  };
}

export function wireLocationsMulti(m: ApiLocationsMulti): WireLocationsMulti {
  return {
    from: m.from,
    to: m.to,
    accounts: m.accounts.map((a) => ({
      account: { id: a.account.id, name: a.account.name },
      points: wireLocationPoints(a.points),
    })),
  };
}

export function wireLeaderboards(l: ApiLeaderboards): WireLeaderboards {
  return {
    period: l.period,
    from: l.from,
    to: l.to,
    leaderboards: l.leaderboards.map((board) => ({
      skill: board.skill,
      entries: board.entries.map((e) => ({
        rank: e.rank,
        account: { id: e.account.id, name: e.account.name },
        gain: e.gain,
      })),
    })),
  };
}

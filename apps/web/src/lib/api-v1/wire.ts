/**
 * The @hub/server read models (camelCase) → the /api/v1 wire format (snake_case for every key the hub
 * defines, D-77). One explicit mapper per type, each returning `z.infer` of its response schema
 * (schemas.ts), so `tsc` catches drift between the docs and what the routes send. Never a generic
 * key converter: some keys are data — skill names ("Attack"), equipment slots, item and account
 * names — and an event's `data` object passes through exactly as the hub stored it.
 *
 * The mappers Download my data needs too (items, skills, presence, vitals, location, a wealth day,
 * an event's own fields) live once in @hub/server (export/wire.ts); `_SharedMappersMatchSchemas`
 * below holds their result types to the schemas.
 *
 * Omitted vs null matters (/accounts/{id}, /snapshot): a field the key's categories don't cover is
 * left out, a readable field the plugin never sent is null or `{ shared: false }`. The mappers keep
 * that distinction: they copy a field only when the read model has it.
 */
import {
  wireEventFields,
  wireItem,
  wireItems,
  wireLocation,
  wirePresence,
  wireSection,
  wireSkills,
  wireVitals,
  wireWealthDay,
  type ApiAccountDetail,
  type ApiAccountSummary,
  type ApiEquipmentHistory,
  type ApiEvent,
  type ApiGains,
  type ApiLeaderboards,
  type ApiLocations,
  type ApiLocationsMulti,
  type ApiLootLeaderboard,
  type ApiMe,
  type ApiOwner,
  type ApiSessions,
  type ApiSnapshotAccount,
  type ApiWealth,
  type ApiXpMulti,
  type ApiXpSeries,
} from '@hub/server';
import type {
  WireAccountDetail,
  WireAccountSummary,
  WireEquipmentHistory,
  WireEvent,
  WireGains,
  WireItem,
  WireItems,
  WireLeaderboards,
  WireLocations,
  WireLocationsMulti,
  WireLootLeaderboard,
  WireMe,
  WireOwner,
  WireSessions,
  WireSkills,
  WireSnapshotAccount,
  WireSnapshotLocation,
  WireWealth,
  WireXpMulti,
  WireXpSeries,
} from './schemas';

export { wireItem };

/** `true` when `A` and `B` are each assignable to the other, else `false`. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;

/** A section of /accounts/{id}: as wireSection builds it from mapper `M`, and as its schema types it. */
type Built<M extends (data: never) => object> = ReturnType<
  typeof wireSection<object, ReturnType<M>>
>;
type SectionOf<K extends keyof WireAccountDetail> = NonNullable<WireAccountDetail[K]>;

/**
 * D-77's compile-time check for the mappers shared with @hub/server: each one's result must be
 * exactly the type its response schema infers. A key added, dropped, renamed or retyped on one
 * side alone makes its entry `false`, which `Assert` refuses.
 */
type _SharedMappersMatchSchemas = [
  Assert<Same<ReturnType<typeof wireItem>, WireItem>>,
  Assert<Same<ReturnType<typeof wireItems>, WireItems>>,
  Assert<Same<ReturnType<typeof wireSkills>, WireSkills>>,
  Assert<Same<Built<typeof wirePresence>, SectionOf<'presence'>>>,
  Assert<Same<Built<typeof wireVitals>, SectionOf<'vitals'>>>,
  Assert<Same<Built<typeof wireLocation>, SectionOf<'location'>>>,
  Assert<Same<Built<typeof wireItems>, SectionOf<'equipment'>>>,
  Assert<Same<ReturnType<typeof wireLocation> & { updated_at: string }, WireSnapshotLocation>>,
  Assert<Same<ReturnType<typeof wireWealthDay>, WireWealth['days'][number]>>,
  Assert<Same<ReturnType<typeof wireEventFields>, Omit<WireEvent, 'account'>>>,
];

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

/** `account_hash` only when the read model has it (service keys, D-91): omitted, never null. */
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
  if (d.presence) out.presence = wireSection(d.presence, wirePresence);
  if (d.vitals) out.vitals = wireSection(d.vitals, wireVitals);
  if (d.skills) out.skills = wireSection(d.skills, wireSkills);
  if (d.location) out.location = wireSection(d.location, wireLocation);
  if (d.equipment) out.equipment = wireSection(d.equipment, wireItems);
  if (d.inventory) out.inventory = wireSection(d.inventory, wireItems);
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
  if (a.gameState !== undefined) out.game_state = a.gameState;
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

/** The event's own fields are the shared mapper's; the API puts the account after `type`. */
export function wireEvent(e: ApiEvent): WireEvent {
  const { id, type, ...rest } = wireEventFields(e);
  return { id, type, account: { id: e.account.id, name: e.account.name }, ...rest };
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
    days: h.days.map(wireWealthDay),
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

export function wireLootLeaderboard(l: ApiLootLeaderboard): WireLootLeaderboard {
  return {
    period: l.period,
    from: l.from,
    to: l.to,
    entries: l.entries.map((e) => ({ rank: e.rank, event: wireEvent(e.event) })),
  };
}

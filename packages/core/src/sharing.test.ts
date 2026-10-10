import { FIXTURES, fixtureJson, type FixtureName } from '@hub/fixtures';
import { describe, expect, it } from 'vitest';
import {
  AUDIENCES,
  CATEGORIES,
  CATEGORY_LABELS,
  DEFAULT_AUDIENCE,
  GUILD_AUDIENCE,
  effectiveAudience,
  isActivePrincipal,
  isAdminPrincipal,
  isCategory,
  isGuildAudience,
  isHiddenFromGuild,
  redactEventData,
  resolveAccess,
  type AccountAccess,
  type Audience,
  type Category,
  type Viewer,
} from './sharing';

const OWNER = 'user-owner';
const CONTRIB = 'user-contrib';
const MEMBER = 'user-member';
const ADMIN = 'user-admin';

function viewer(userId: string, over: Partial<Viewer> = {}): Viewer {
  return { userId, status: 'active', isAdmin: false, ...over };
}

function account(over: Partial<AccountAccess> = {}): AccountAccess {
  return {
    status: 'active',
    ownerUserId: OWNER,
    links: [
      { userId: OWNER, role: 'owner', blocked: false },
      { userId: CONTRIB, role: 'contributor', blocked: false },
    ],
    sharing: {},
    grants: [],
    hiddenFromGuild: false,
    ...over,
  };
}

/** Every category set to one audience. */
function all(audience: Audience): Partial<Record<Category, Audience>> {
  return Object.fromEntries(CATEGORIES.map((c) => [c, audience]));
}

const sorted = (s: ReadonlySet<Category>) => [...s].sort();
const ALL = [...CATEGORIES].sort();
/** What a member sees of an account with no sharing rows: every category is guild by default (D-96). */
const DEFAULT_GUILD: Category[] = ALL;

describe('constants', () => {
  it('has the seven handoff §10 categories and hiscores (D-105)', () => {
    expect(CATEGORIES).toEqual([
      'stats',
      'events',
      'activity',
      'location_live',
      'location_history',
      'equipment',
      'inventory',
      'hiscores',
    ]);
    expect(AUDIENCES).toEqual(['private', 'guild', 'selected']);
  });

  it('defaults every category to guild (D-96, D-105)', () => {
    expect(DEFAULT_AUDIENCE).toEqual({
      stats: 'guild',
      events: 'guild',
      activity: 'guild',
      location_live: 'guild',
      location_history: 'guild',
      equipment: 'guild',
      inventory: 'guild',
      hiscores: 'guild',
    });
  });

  it('labels every category', () => {
    expect(Object.keys(CATEGORY_LABELS).sort()).toEqual(ALL);
    for (const c of CATEGORIES) {
      expect(CATEGORY_LABELS[c].label).not.toBe('');
      expect(CATEGORY_LABELS[c].covers).not.toBe('');
    }
  });
});

describe('isCategory', () => {
  it('accepts every category', () => {
    for (const c of CATEGORIES) expect(isCategory(c)).toBe(true);
  });

  it('rejects anything else', () => {
    for (const v of [
      'Stats',
      'STATS',
      ' stats',
      'stats ',
      '',
      'location',
      'guild',
      'toString',
      '__proto__',
    ]) {
      expect(isCategory(v)).toBe(false);
    }
    for (const v of [null, undefined, 0, 1, true, {}, ['stats'], new String('stats')]) {
      expect(isCategory(v)).toBe(false);
    }
  });
});

describe('effectiveAudience', () => {
  it('uses DEFAULT_AUDIENCE for a missing account_sharing row', () => {
    for (const c of CATEGORIES)
      expect(effectiveAudience({ sharing: {} }, c)).toBe(DEFAULT_AUDIENCE[c]);
  });

  it('uses the explicit audience when set', () => {
    const sharing = { stats: 'private', inventory: 'guild', equipment: 'selected' } as const;
    expect(effectiveAudience({ sharing }, 'stats')).toBe('private');
    expect(effectiveAudience({ sharing }, 'inventory')).toBe('guild');
    expect(effectiveAudience({ sharing }, 'equipment')).toBe('selected');
    // Others stay default.
    expect(effectiveAudience({ sharing }, 'events')).toBe('guild');
    expect(effectiveAudience({ sharing }, 'location_live')).toBe('guild');
    expect(effectiveAudience({ sharing }, 'location_history')).toBe('guild');
  });

  it('treats a null value as missing', () => {
    const sharing = { stats: null } as unknown as AccountAccess['sharing'];
    expect(effectiveAudience({ sharing }, 'stats')).toBe('guild');
  });

  it('fails closed to private on an unknown stored value', () => {
    const sharing = { stats: 'everyone', events: 'GUILD' } as unknown as AccountAccess['sharing'];
    expect(effectiveAudience({ sharing }, 'stats')).toBe('private');
    expect(effectiveAudience({ sharing }, 'events')).toBe('private');
  });

  it('ignores inherited properties', () => {
    const sharing = Object.create({ stats: 'private' }) as AccountAccess['sharing'];
    expect(effectiveAudience({ sharing }, 'stats')).toBe('guild');
  });

  it('fails closed to private for a value that is not a category at runtime', () => {
    // Object.prototype keys must not leak a function or an object out as the audience.
    for (const c of ['toString', '__proto__', 'constructor', 'hasOwnProperty', 'location', '']) {
      expect(effectiveAudience({ sharing: {} }, c as Category)).toBe('private');
    }
    const sharing = { foo: 'guild' } as unknown as AccountAccess['sharing'];
    expect(effectiveAudience({ sharing }, 'foo' as Category)).toBe('private');
  });
});

describe('resolveAccess', () => {
  describe('inactive viewer', () => {
    it('sees nothing, whatever their relation', () => {
      for (const userId of [OWNER, CONTRIB, MEMBER]) {
        const r = resolveAccess(
          viewer(userId, { status: 'grace' }),
          account({ sharing: all('guild') }),
        );
        expect(r.visible).toBe(false);
        expect(r.categories.size).toBe(0);
        expect(r.canManage).toBe(false);
        expect(r.relation).toBe('none');
      }
    });

    it('applies to admins too', () => {
      const r = resolveAccess(viewer(ADMIN, { status: 'grace', isAdmin: true }), account());
      expect(r).toEqual({
        visible: false,
        categories: new Set(),
        relation: 'none',
        canManage: false,
      });
    });

    it('fails closed on an unexpected status', () => {
      const v = { ...viewer(OWNER), status: 'deleted' } as unknown as Viewer;
      expect(resolveAccess(v, account()).visible).toBe(false);
    });
  });

  describe('owner', () => {
    it('sees every category and can manage, even when everything is private', () => {
      const r = resolveAccess(viewer(OWNER), account({ sharing: all('private') }));
      expect(r.relation).toBe('owner');
      expect(sorted(r.categories)).toEqual(ALL);
      expect(r.visible).toBe(true);
      expect(r.canManage).toBe(true);
    });

    it('is decided by ownerUserId, not by the link role', () => {
      // After a transfer, a stale 'owner' link doesn't make the previous owner the owner.
      const acc = account({
        ownerUserId: CONTRIB,
        links: [
          { userId: OWNER, role: 'owner', blocked: false },
          { userId: CONTRIB, role: 'contributor', blocked: false },
        ],
      });
      expect(resolveAccess(viewer(CONTRIB), acc).relation).toBe('owner');
      expect(resolveAccess(viewer(CONTRIB), acc).canManage).toBe(true);
      expect(resolveAccess(viewer(OWNER), acc).relation).toBe('contributor');
      expect(resolveAccess(viewer(OWNER), acc).canManage).toBe(false);
    });

    it('is the owner even without a link row', () => {
      const r = resolveAccess(viewer(OWNER), account({ links: [] }));
      expect(r.relation).toBe('owner');
      expect(r.canManage).toBe(true);
    });

    it('stays the owner when their own link is blocked', () => {
      const r = resolveAccess(
        viewer(OWNER),
        account({
          links: [{ userId: OWNER, role: 'owner', blocked: true }],
          sharing: all('private'),
        }),
      );
      expect(r.relation).toBe('owner');
      expect(sorted(r.categories)).toEqual(ALL);
    });

    it('nobody is the owner of an unowned account', () => {
      const acc = account({ ownerUserId: null, sharing: all('private') });
      const r = resolveAccess(viewer(OWNER), acc);
      expect(r.relation).toBe('contributor');
      expect(r.canManage).toBe(false);
      expect(resolveAccess(viewer(MEMBER), acc).relation).toBe('member');
    });
  });

  describe('contributor', () => {
    it('sees every category but cannot manage', () => {
      const r = resolveAccess(viewer(CONTRIB), account({ sharing: all('private') }));
      expect(r.relation).toBe('contributor');
      expect(sorted(r.categories)).toEqual(ALL);
      expect(r.visible).toBe(true);
      expect(r.canManage).toBe(false);
    });

    it('sees every category even with selected audiences and no grants', () => {
      const r = resolveAccess(viewer(CONTRIB), account({ sharing: all('selected') }));
      expect(sorted(r.categories)).toEqual(ALL);
    });
  });

  describe('blocked contributor', () => {
    const blocked = (sharing: AccountAccess['sharing'], grants: AccountAccess['grants'] = []) =>
      account({
        links: [
          { userId: OWNER, role: 'owner', blocked: false },
          { userId: CONTRIB, role: 'contributor', blocked: true },
        ],
        sharing,
        grants,
      });

    it('is treated as a plain member (defaults)', () => {
      const r = resolveAccess(viewer(CONTRIB), blocked({}));
      expect(r.relation).toBe('member');
      expect(sorted(r.categories)).toEqual(DEFAULT_GUILD);
      expect(r.visible).toBe(true);
      expect(r.canManage).toBe(false);
    });

    it('is invisible when everything is private', () => {
      const r = resolveAccess(viewer(CONTRIB), blocked(all('private')));
      expect(r.relation).toBe('member');
      expect(r.visible).toBe(false);
      expect(r.categories.size).toBe(0);
    });

    it('still gets selected categories through grants', () => {
      const r = resolveAccess(
        viewer(CONTRIB),
        blocked({ ...all('private'), inventory: 'selected' }, [
          { category: 'inventory', userId: CONTRIB },
        ]),
      );
      expect(sorted(r.categories)).toEqual(['inventory']);
      expect(r.visible).toBe(true);
    });

    it('stays a contributor when another (non-blocked) link of theirs exists', () => {
      const acc = account({
        links: [
          { userId: CONTRIB, role: 'contributor', blocked: true },
          { userId: CONTRIB, role: 'contributor', blocked: false },
        ],
      });
      expect(resolveAccess(viewer(CONTRIB), acc).relation).toBe('contributor');
    });
  });

  describe('guild audience (D-89)', () => {
    it('sees exactly the guild categories, as a member, and never manages', () => {
      const r = resolveAccess(GUILD_AUDIENCE, account());
      expect(r.relation).toBe('member');
      expect(sorted(r.categories)).toEqual(DEFAULT_GUILD);
      expect(r.visible).toBe(true);
      expect(r.canManage).toBe(false);
    });

    it('gets nothing from selected audiences, whatever the grants say', () => {
      const r = resolveAccess(
        GUILD_AUDIENCE,
        account({
          sharing: { ...all('selected'), stats: 'guild' },
          grants: CATEGORIES.map((category) => ({ category, userId: MEMBER })),
        }),
      );
      expect(sorted(r.categories)).toEqual(['stats']);
    });

    it('is invisible when everything is private, and for hidden accounts', () => {
      const closed = resolveAccess(GUILD_AUDIENCE, account({ sharing: all('private') }));
      expect(closed.visible).toBe(false);
      expect(closed.categories.size).toBe(0);
      expect(closed.relation).toBe('member');
      const hidden = resolveAccess(GUILD_AUDIENCE, account({ status: 'hidden' }));
      expect(hidden).toEqual({
        visible: false,
        categories: new Set(),
        relation: 'none',
        canManage: false,
      });
    });

    it('is never an owner or contributor: links and ownership give it nothing extra', () => {
      const r = resolveAccess(
        GUILD_AUDIENCE,
        account({ ownerUserId: OWNER, sharing: { ...all('private'), events: 'guild' } }),
      );
      expect(sorted(r.categories)).toEqual(['events']);
    });

    it('is active and never an admin', () => {
      expect(isGuildAudience(GUILD_AUDIENCE)).toBe(true);
      expect(isGuildAudience(viewer(MEMBER))).toBe(false);
      expect(isActivePrincipal(GUILD_AUDIENCE)).toBe(true);
      expect(isActivePrincipal(viewer(MEMBER, { status: 'grace' }))).toBe(false);
      expect(isAdminPrincipal(GUILD_AUDIENCE)).toBe(false);
      expect(isAdminPrincipal(viewer(ADMIN, { isAdmin: true }))).toBe(true);
    });
  });

  describe('member', () => {
    it('sees the default guild categories', () => {
      const r = resolveAccess(viewer(MEMBER), account());
      expect(r.relation).toBe('member');
      expect(sorted(r.categories)).toEqual(DEFAULT_GUILD);
      expect(r.visible).toBe(true);
      expect(r.canManage).toBe(false);
    });

    it('guild audience → allowed', () => {
      const r = resolveAccess(viewer(MEMBER), account({ sharing: all('guild') }));
      expect(sorted(r.categories)).toEqual(ALL);
    });

    it('private audience → denied', () => {
      const r = resolveAccess(viewer(MEMBER), account({ sharing: { stats: 'private' } }));
      expect(r.categories.has('stats')).toBe(false);
      expect(sorted(r.categories)).toEqual(ALL.filter((c) => c !== 'stats'));
    });

    it('is invisible when nothing is allowed', () => {
      const r = resolveAccess(viewer(MEMBER), account({ sharing: all('private') }));
      expect(r.visible).toBe(false);
      expect(r.categories.size).toBe(0);
      expect(r.relation).toBe('member');
    });

    it('selected audience without a grant → denied', () => {
      const r = resolveAccess(viewer(MEMBER), account({ sharing: all('selected') }));
      expect(r.categories.size).toBe(0);
      expect(r.visible).toBe(false);
    });

    it('selected audience with a grant for this viewer and category → allowed', () => {
      const r = resolveAccess(
        viewer(MEMBER),
        account({
          sharing: { ...all('selected'), stats: 'private' },
          grants: [
            { category: 'location_live', userId: MEMBER },
            { category: 'equipment', userId: MEMBER },
          ],
        }),
      );
      expect(sorted(r.categories)).toEqual(['equipment', 'location_live']);
      expect(r.visible).toBe(true);
    });

    it("another user's grant doesn't count", () => {
      const r = resolveAccess(
        viewer(MEMBER),
        account({
          sharing: { inventory: 'selected' },
          grants: [{ category: 'inventory', userId: 'someone-else' }],
        }),
      );
      expect(r.categories.has('inventory')).toBe(false);
    });

    it("a grant for another category doesn't count", () => {
      const r = resolveAccess(
        viewer(MEMBER),
        account({
          sharing: { inventory: 'selected', equipment: 'private' },
          grants: [{ category: 'equipment', userId: MEMBER }],
        }),
      );
      expect(r.categories.has('inventory')).toBe(false);
      // equipment is private, so the grant alone doesn't open it either.
      expect(r.categories.has('equipment')).toBe(false);
    });

    it('a grant never overrides a private audience', () => {
      const r = resolveAccess(
        viewer(MEMBER),
        account({
          sharing: all('private'),
          grants: CATEGORIES.map((category) => ({ category, userId: MEMBER })),
        }),
      );
      expect(r.categories.size).toBe(0);
      expect(r.visible).toBe(false);
    });

    it('a grant is irrelevant for a guild audience', () => {
      const r = resolveAccess(
        viewer(MEMBER),
        account({ sharing: { stats: 'guild' }, grants: [{ category: 'stats', userId: MEMBER }] }),
      );
      expect(r.categories.has('stats')).toBe(true);
    });
  });

  describe('admin', () => {
    it('follows the normal rules for categories but is always visible and can manage', () => {
      const r = resolveAccess(
        viewer(ADMIN, { isAdmin: true }),
        account({ sharing: all('private') }),
      );
      expect(r.relation).toBe('member');
      expect(r.categories.size).toBe(0);
      expect(r.visible).toBe(true);
      expect(r.canManage).toBe(true);
    });

    it('gets default categories as a member', () => {
      const r = resolveAccess(viewer(ADMIN, { isAdmin: true }), account());
      expect(sorted(r.categories)).toEqual(DEFAULT_GUILD);
    });

    it('sees everything as a contributor', () => {
      const acc = account({
        links: [{ userId: ADMIN, role: 'contributor', blocked: false }],
        sharing: all('private'),
      });
      const r = resolveAccess(viewer(ADMIN, { isAdmin: true }), acc);
      expect(r.relation).toBe('contributor');
      expect(sorted(r.categories)).toEqual(ALL);
      expect(r.canManage).toBe(true);
    });
  });

  describe('hidden account (owner in grace, no transfer)', () => {
    const hidden = (over: Partial<AccountAccess> = {}) =>
      account({ status: 'hidden', sharing: all('guild'), ...over });
    const nothing = { visible: false, categories: new Set(), relation: 'none', canManage: false };

    it('is invisible to a non-admin member, even with guild audiences', () => {
      expect(resolveAccess(viewer(MEMBER), hidden())).toEqual(nothing);
    });

    it('is invisible to a non-admin contributor', () => {
      expect(resolveAccess(viewer(CONTRIB), hidden())).toEqual(nothing);
    });

    it('is invisible to a non-admin with grants', () => {
      const acc = hidden({
        sharing: all('selected'),
        grants: [{ category: 'stats', userId: MEMBER }],
      });
      expect(resolveAccess(viewer(MEMBER), acc)).toEqual(nothing);
    });

    it('is invisible (and unmanageable) to an active non-admin owner', () => {
      expect(resolveAccess(viewer(OWNER), hidden())).toEqual(nothing);
    });

    it('follows the normal rules for an admin', () => {
      const r = resolveAccess(viewer(ADMIN, { isAdmin: true }), hidden({ sharing: {} }));
      expect(r.visible).toBe(true);
      expect(r.relation).toBe('member');
      expect(sorted(r.categories)).toEqual(DEFAULT_GUILD);
      expect(r.canManage).toBe(true);
    });

    it('gives an admin contributor every category', () => {
      const acc = hidden({
        links: [{ userId: ADMIN, role: 'contributor', blocked: false }],
        sharing: all('private'),
      });
      const r = resolveAccess(viewer(ADMIN, { isAdmin: true }), acc);
      expect(r.relation).toBe('contributor');
      expect(sorted(r.categories)).toEqual(ALL);
    });

    it('is visible to an admin even when everything is private', () => {
      const r = resolveAccess(
        viewer(ADMIN, { isAdmin: true }),
        hidden({ sharing: all('private') }),
      );
      expect(r.visible).toBe(true);
      expect(r.categories.size).toBe(0);
    });

    it('fails closed on an unexpected account status', () => {
      const acc = { ...account(), status: 'deleted' } as unknown as AccountAccess;
      expect(resolveAccess(viewer(MEMBER), acc).visible).toBe(false);
      expect(resolveAccess(viewer(ADMIN, { isAdmin: true }), acc).visible).toBe(true);
    });
  });

  describe('canManage', () => {
    it('owner yes, admin yes, contributor no, member no', () => {
      const acc = account();
      expect(resolveAccess(viewer(OWNER), acc).canManage).toBe(true);
      expect(resolveAccess(viewer(ADMIN, { isAdmin: true }), acc).canManage).toBe(true);
      expect(resolveAccess(viewer(CONTRIB), acc).canManage).toBe(false);
      expect(resolveAccess(viewer(MEMBER), acc).canManage).toBe(false);
    });

    it('requires an active viewer', () => {
      const acc = account();
      expect(resolveAccess(viewer(OWNER, { status: 'grace' }), acc).canManage).toBe(false);
      expect(resolveAccess(viewer(ADMIN, { status: 'grace', isAdmin: true }), acc).canManage).toBe(
        false,
      );
    });
  });

  it('owner/contributor relations and canManage always imply visible', () => {
    const accounts = [
      account(),
      account({ sharing: all('private') }),
      account({ status: 'hidden' }),
    ];
    const viewers = [OWNER, CONTRIB, MEMBER, ADMIN].flatMap((id) => [
      viewer(id),
      viewer(id, { isAdmin: true }),
      viewer(id, { status: 'grace' }),
    ]);
    for (const acc of accounts) {
      for (const v of viewers) {
        const r = resolveAccess(v, acc);
        if (r.relation === 'owner' || r.relation === 'contributor' || r.canManage)
          expect(r.visible).toBe(true);
        if (r.categories.size > 0) expect(r.visible).toBe(true);
        if (r.relation === 'none') expect(r.categories.size).toBe(0);
      }
    }
  });

  it('returns a fresh categories set on every call', () => {
    const acc = account({ sharing: { inventory: 'private' } });
    const a = resolveAccess(viewer(MEMBER), acc);
    (a.categories as Set<Category>).add('inventory');
    expect(resolveAccess(viewer(MEMBER), acc).categories.has('inventory')).toBe(false);
    const n = resolveAccess(viewer(MEMBER, { status: 'grace' }), acc);
    (n.categories as Set<Category>).add('stats');
    expect(resolveAccess(viewer(MEMBER, { status: 'grace' }), acc).categories.size).toBe(0);
  });

  it('fails closed on non-boolean isAdmin and blocked flags, and always returns booleans', () => {
    const acc = account({ sharing: all('private') });
    for (const isAdmin of [undefined, null, 'false', 1] as unknown as boolean[]) {
      const r = resolveAccess(viewer(MEMBER, { isAdmin }), acc);
      expect(r).toEqual({
        visible: false,
        categories: new Set(),
        relation: 'member',
        canManage: false,
      });
      expect(resolveAccess(viewer(MEMBER, { isAdmin }), { ...acc, status: 'hidden' }).visible).toBe(
        false,
      );
    }
    for (const blocked of [undefined, null, 'false', 0] as unknown as boolean[]) {
      const withLink = account({
        links: [{ userId: CONTRIB, role: 'contributor', blocked }],
        sharing: all('private'),
      });
      expect(resolveAccess(viewer(CONTRIB), withLink).relation).toBe('member');
    }
  });

  it("doesn't mutate its inputs", () => {
    const acc = account({
      sharing: { inventory: 'selected' },
      grants: [{ category: 'inventory', userId: MEMBER }],
    });
    const v = viewer(MEMBER);
    const before = structuredClone({ acc, v });
    resolveAccess(v, acc);
    expect({ acc, v }).toEqual(before);
  });
});

describe('redactEventData', () => {
  /** The stored `events.data`: the original event envelope from a fixture payload. */
  function storedEvent(name: FixtureName, index = 0): Record<string, unknown> {
    const events = fixtureJson<{ events: Record<string, unknown>[] }>(name).events;
    const ev = events[index];
    if (!ev) throw new Error(`no event ${index} in ${name}`);
    return ev;
  }
  const none = new Set<Category>();
  const allButLocation = new Set<Category>([
    'stats',
    'events',
    'activity',
    'equipment',
    'inventory',
  ]);

  it('strips data.location from a death for a viewer without location categories', () => {
    const ev = storedEvent('event-death-dangerous');
    const before = structuredClone(ev);
    const out = redactEventData(ev, allButLocation) as Record<string, unknown>;

    expect(out).not.toBe(ev);
    const data = out.data as Record<string, unknown>;
    expect(data).not.toHaveProperty('location');
    // Everything else is kept.
    const { location: _location, ...rest } = before.data as Record<string, unknown>;
    expect(data).toEqual(rest);
    expect(out.type).toBe('death');
    expect(out.eventId).toBe(before.eventId);
    expect(out.timestamp).toBe(before.timestamp);
    expect(Object.keys(out)).toEqual(Object.keys(before));
    // The input is untouched.
    expect(ev).toEqual(before);
    expect((ev.data as Record<string, unknown>).location).toEqual({ x: 3068, y: 3858, plane: 0 });
  });

  it('strips a SAFE death too', () => {
    const out = redactEventData(storedEvent('event-death-safe'), none) as { data: object };
    expect(out.data).not.toHaveProperty('location');
    expect(out.data).toHaveProperty('keptItems');
  });

  it('strips data.location from a superior_spawn', () => {
    const ev = storedEvent('event-superior');
    const before = structuredClone(ev);
    const out = redactEventData(ev, none) as Record<string, unknown>;
    expect(out.data).toEqual({ name: 'Nechryarch', npcId: 7411 });
    expect(out.type).toBe('superiorSpawn');
    expect(ev).toEqual(before);
  });

  it('keeps the location with location_live or location_history (same object)', () => {
    for (const cat of ['location_live', 'location_history'] as const) {
      const death = storedEvent('event-death-dangerous');
      expect(redactEventData(death, new Set([cat]))).toBe(death);
      const sup = storedEvent('event-superior');
      expect(redactEventData(sup, new Set([cat]))).toBe(sup);
    }
  });

  it('returns events without a location unchanged (same object)', () => {
    const cases: FixtureName[] = [
      'event-loot',
      'event-pkloot',
      'event-levelup-multi',
      'event-collectionlog',
      'event-diary-repeat',
      'event-combattask',
      'event-unknown-type',
    ];
    for (const name of cases) {
      const ev = storedEvent(name);
      expect(redactEventData(ev, none)).toBe(ev);
    }
  });

  it('strips a location from any other or future event type too (fail closed)', () => {
    // Unknown types are stored as sent and newer plugins may add fields to known types; a `location`
    // is coordinates whatever the event, so it is gated by the location categories.
    const pet = {
      type: 'petDrop',
      data: { name: 'Baby mole', location: { x: 1, y: 2, plane: 0 } },
      eventId: 'e',
      timestamp: 1,
    };
    expect(redactEventData(pet, none)).toEqual({
      type: 'petDrop',
      data: { name: 'Baby mole' },
      eventId: 'e',
      timestamp: 1,
    });
    const loot = storedEvent('event-loot');
    (loot.data as Record<string, unknown>).location = { x: 3222, y: 3218, plane: 0 };
    const out = redactEventData(loot, none) as { data: Record<string, unknown> };
    expect(out.data).not.toHaveProperty('location');
    expect(out.data.totalValue).toBe((loot.data as Record<string, unknown>).totalValue);
    expect(redactEventData(pet, new Set(['location_live']))).toBe(pet);
  });

  it('leaves no location in any fixture event, and passes each through unchanged with a location category', () => {
    for (const name of FIXTURES) {
      for (const ev of fixtureJson<{ events?: unknown[] }>(name).events ?? []) {
        expect(JSON.stringify(redactEventData(ev, allButLocation) ?? null)).not.toContain(
          '"location"',
        );
        expect(redactEventData(ev, new Set(['location_history']))).toBe(ev);
      }
    }
  });

  it('returns the same object when there is no location to strip', () => {
    const ev = {
      type: 'death',
      data: { valueLost: 0, danger: 'SAFE' },
      eventId: 'e',
      timestamp: 1,
    };
    expect(redactEventData(ev, none)).toBe(ev);
  });

  it('passes through values that are not an event object', () => {
    for (const v of [null, undefined, 'death', 42, true]) expect(redactEventData(v, none)).toBe(v);
    const arr = [{ location: { x: 1, y: 1, plane: 0 } }];
    expect(redactEventData(arr, none)).toBe(arr);
  });

  it('leaves a non-object data alone', () => {
    for (const data of ['x', 3, null, [{ location: {} }]]) {
      const ev = { type: 'death', data, eventId: 'e', timestamp: 1 };
      expect(redactEventData(ev, none)).toBe(ev);
    }
  });

  it('strips a location that is null or malformed too', () => {
    const ev = {
      type: 'death',
      data: { location: null, valueLost: 5 },
      eventId: 'e',
      timestamp: 1,
    };
    expect(redactEventData(ev, none)).toEqual({
      type: 'death',
      data: { valueLost: 5 },
      eventId: 'e',
      timestamp: 1,
    });
  });

  it('strips a top-level location (inner data passed by mistake)', () => {
    const inner = { name: 'Nechryarch', npcId: 7411, location: { x: 1, y: 2, plane: 0 } };
    const out = redactEventData(inner, none);
    expect(out).toEqual({ name: 'Nechryarch', npcId: 7411 });
    expect(inner.location).toEqual({ x: 1, y: 2, plane: 0 });
  });

  it('works on the output of the resolver', () => {
    const noLocation = { location_live: 'private', location_history: 'private' } as const;
    const member = resolveAccess(viewer(MEMBER), account({ sharing: noLocation }));
    const owner = resolveAccess(viewer(OWNER), account({ sharing: noLocation }));
    const ev = storedEvent('event-death-dangerous');
    expect((redactEventData(ev, member.categories) as { data: object }).data).not.toHaveProperty(
      'location',
    );
    expect(redactEventData(ev, owner.categories)).toBe(ev);
    const shared = resolveAccess(
      viewer(MEMBER),
      account({ sharing: { ...noLocation, location_history: 'guild' } }),
    );
    expect(redactEventData(ev, shared.categories)).toBe(ev);
    // By default a member gets both location categories (D-96), so the coordinates are kept.
    const byDefault = resolveAccess(viewer(MEMBER), account());
    expect(redactEventData(ev, byDefault.categories)).toBe(ev);
  });
});

describe('resolveAccess: hidden from the guild (D-104)', () => {
  // Shared with everyone and granted to the member: the flag must win over both.
  const hidden = account({
    hiddenFromGuild: true,
    sharing: all('guild'),
    grants: CATEGORIES.map((category) => ({ category, userId: MEMBER })),
  });

  it('leaves the owner and contributors everything', () => {
    for (const id of [OWNER, CONTRIB]) {
      const r = resolveAccess(viewer(id), hidden);
      expect(r.visible).toBe(true);
      expect(sorted(r.categories)).toEqual(ALL);
    }
    expect(resolveAccess(viewer(OWNER), hidden).canManage).toBe(true);
  });

  it('shows a member nothing, guild audiences and grants included', () => {
    expect(resolveAccess(viewer(MEMBER), hidden)).toEqual({
      visible: false,
      categories: new Set(),
      relation: 'none',
      canManage: false,
    });
  });

  it('shows the guild audience (service keys) nothing', () => {
    const r = resolveAccess(GUILD_AUDIENCE, hidden);
    expect(r.visible).toBe(false);
    expect(r.categories.size).toBe(0);
  });

  it('treats a blocked contributor as a member', () => {
    const blocked = account({
      hiddenFromGuild: true,
      sharing: all('guild'),
      links: [{ userId: CONTRIB, role: 'contributor', blocked: true }],
    });
    expect(resolveAccess(viewer(CONTRIB), blocked).visible).toBe(false);
  });

  it('keeps the admin override (to manage it) but no category', () => {
    const r = resolveAccess(viewer(ADMIN, { isAdmin: true }), hidden);
    expect(r).toEqual({
      visible: true,
      categories: new Set(),
      relation: 'member',
      canManage: true,
    });
  });

  it('fails closed: anything but false is hidden', () => {
    expect(isHiddenFromGuild({ hiddenFromGuild: false })).toBe(false);
    expect(isHiddenFromGuild({ hiddenFromGuild: true })).toBe(true);
    const odd = { ...account({ sharing: all('guild') }), hiddenFromGuild: undefined };
    expect(isHiddenFromGuild(odd as unknown as AccountAccess)).toBe(true);
    expect(resolveAccess(viewer(MEMBER), odd as unknown as AccountAccess).visible).toBe(false);
  });

  it('changes nothing while off', () => {
    const shown = account({ sharing: all('guild') });
    expect(sorted(resolveAccess(viewer(MEMBER), shown).categories)).toEqual(ALL);
    expect(sorted(resolveAccess(GUILD_AUDIENCE, shown).categories)).toEqual(ALL);
  });
});

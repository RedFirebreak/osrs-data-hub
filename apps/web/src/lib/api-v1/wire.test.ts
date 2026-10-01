/**
 * The wire mappers (wire.ts, D-77): snake_case for the hub's own keys, data keys untouched (skill
 * and slot names, an event's `data` with its camelCase plugin keys), and omitted vs null kept apart.
 * Each result is parsed with its response schema, so the mappers and the documentation agree.
 */
import type { ApiAccountDetail, ApiEvent, ApiSnapshotAccount } from '@hub/server';
import { describe, expect, it } from 'vitest';
import { AccountDetail, Event, Item, SnapshotAccount } from './schemas';
import { wireAccountDetail, wireEvent, wireItem, wireSnapshotAccount } from './wire';

const AT = '2026-09-29T10:00:00.000Z';

describe('wireAccountDetail', () => {
  const detail: ApiAccountDetail = {
    id: 'acc1',
    name: 'Zezima',
    type: 0,
    typeLabel: 'Normal',
    owner: { name: 'Owner', discordId: '100000000000000001' },
    firstSeen: AT,
    categories: ['stats', 'equipment', 'location_live'],
    skills: {
      shared: true,
      updatedAt: AT,
      totalLevel: 2277,
      overallXp: 500,
      skills: [
        { skill: 'Overall', level: 2277, realLevel: 2277, xp: 500 },
        { skill: 'Attack', level: 108, realLevel: 99, xp: 500 },
      ],
    },
    equipment: {
      shared: true,
      updatedAt: AT,
      value: 10,
      items: [
        {
          id: 1,
          name: 'Whip',
          quantity: 1,
          gePrice: 10,
          haPrice: null,
          equipmentSlot: 'WEAPON',
          inventorySlot: null,
        },
      ],
    },
    location: { shared: false, updatedAt: null },
  };

  it('renames the hub’s keys, keeps data keys and keeps sections omitted or not shared', () => {
    const wire = wireAccountDetail(detail);
    expect(AccountDetail.parse(wire)).toEqual(wire);
    expect(wire).toEqual({
      id: 'acc1',
      name: 'Zezima',
      type: 0,
      type_label: 'Normal',
      owner: { name: 'Owner', discord_id: '100000000000000001' },
      first_seen: AT,
      categories: ['stats', 'equipment', 'location_live'],
      skills: {
        shared: true,
        updated_at: AT,
        total_level: 2277,
        overall_xp: 500,
        skills: [
          { skill: 'Overall', level: 2277, real_level: 2277, xp: 500 },
          { skill: 'Attack', level: 108, real_level: 99, xp: 500 },
        ],
      },
      equipment: {
        shared: true,
        updated_at: AT,
        value: 10,
        items: [
          {
            id: 1,
            name: 'Whip',
            quantity: 1,
            ge_price: 10,
            ha_price: null,
            equipment_slot: 'WEAPON',
            inventory_slot: null,
          },
        ],
      },
      location: { shared: false, updated_at: null },
    });
    expect(wire).not.toHaveProperty('presence');
    expect(wire).not.toHaveProperty('inventory');
  });
});

describe('wireSnapshotAccount', () => {
  it('copies only the fields the read model has, null included', () => {
    const account: ApiSnapshotAccount = {
      id: 'acc1',
      name: 'Zezima',
      type: null,
      typeLabel: 'Unknown',
      owner: null,
      categories: ['activity', 'location_live'],
      online: false,
      world: null,
      specialWorld: false,
      gameState: null,
      lastSeen: AT,
      hp: null,
      prayer: { current: 1, max: 2 },
      spellbook: null,
      location: null,
    };
    const wire = wireSnapshotAccount(account);
    expect(SnapshotAccount.parse(wire)).toEqual(wire);
    expect(wire).toEqual({
      id: 'acc1',
      name: 'Zezima',
      type: null,
      type_label: 'Unknown',
      owner: null,
      categories: ['activity', 'location_live'],
      online: false,
      world: null,
      special_world: false,
      game_state: null,
      last_seen: AT,
      hp: null,
      prayer: { current: 1, max: 2 },
      spellbook: null,
      location: null,
    });
    for (const omitted of ['skills', 'equipment', 'inventory', 'account_hash']) {
      expect(wire).not.toHaveProperty(omitted);
    }
    // Activity fields only when the read model has them (the key reads `activity`).
    const { gameState: _g, ...withoutState } = account;
    expect(wireSnapshotAccount(withoutState)).not.toHaveProperty('game_state');
    expect(wireSnapshotAccount({ ...account, gameState: 'LOGGED_IN' }).game_state).toBe(
      'LOGGED_IN',
    );
    // The hash only when the read model carries it (service keys, D-91).
    const hashed = wireSnapshotAccount({ ...account, accountHash: 'a'.repeat(56) });
    expect(SnapshotAccount.parse(hashed)).toEqual(hashed);
    expect(hashed.account_hash).toBe('a'.repeat(56));

    const located = wireSnapshotAccount({
      ...account,
      location: { x: 1, y: 2, plane: 0, isOnBoat: true, stale: true, updatedAt: AT },
    });
    expect(located.location).toEqual({
      x: 1,
      y: 2,
      plane: 0,
      is_on_boat: true,
      stale: true,
      updated_at: AT,
    });
  });
});

describe('wireItem', () => {
  it('carries the inventory slot plugin 1.5.1 sends', () => {
    const wire = wireItem({
      id: 385,
      name: 'Shark',
      quantity: 1,
      gePrice: 900,
      haPrice: 60,
      equipmentSlot: null,
      inventorySlot: 27,
    });
    expect(Item.parse(wire)).toEqual(wire);
    expect(wire).toMatchObject({ equipment_slot: null, inventory_slot: 27 });
  });
});

describe('wireEvent', () => {
  it('passes the event’s data through exactly as stored', () => {
    const data = {
      type: 'loot',
      eventId: 'e-1',
      timestamp: 1,
      data: { items: [{ gePrice: 5, haPrice: 1, id: 4151 }], npcId: 3162 },
    };
    const event: ApiEvent = {
      id: '0192f0e2-8d3c-7cc4-a4f4-0123456789ab',
      type: 'loot',
      account: { id: 'acc1', name: 'Zezima' },
      occurredAt: AT,
      receivedAt: AT,
      valueGp: 5,
      itemId: 4151,
      npcId: 3162,
      skill: null,
      level: null,
      tier: null,
      points: null,
      specialWorld: false,
      data,
      title: 'Loot',
      line: 'Zezima received Abyssal whip',
    };
    const wire = wireEvent(event);
    expect(Event.parse(wire)).toEqual(wire);
    expect(wire.data).toBe(data);
    expect(wire).toMatchObject({
      occurred_at: AT,
      received_at: AT,
      value_gp: 5,
      item_id: 4151,
      npc_id: 3162,
      special_world: false,
    });
    expect(wire).not.toHaveProperty('occurredAt');
    // The account sits where the documentation shows it: after `type`.
    expect(Object.keys(wire).slice(0, 4)).toEqual(['id', 'type', 'account', 'occurred_at']);
    // A stored event that isn't an object (a storage bug) still matches the documented type.
    for (const broken of ['text', 7, null, [1, 2]]) {
      const guarded = wireEvent({ ...event, data: broken });
      expect(Event.parse(guarded)).toEqual(guarded);
      expect(guarded.data).toEqual({});
    }
  });
});

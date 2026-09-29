/** Fixtures for the live client's unit tests (imported by *.test.ts only). */
import type { FeedEvent } from '@hub/server';

/** A FeedEvent as the server sends it; override any field. */
export function feedEvent(overrides: Partial<FeedEvent> = {}): FeedEvent {
  return {
    id: '0199a8b6-0000-7000-8000-000000000001',
    seq: 10,
    type: 'loot',
    account: { publicId: 'AbCdEf123456', name: 'Zezima' },
    occurredAt: '2026-09-29T10:00:00.000Z',
    receivedAt: '2026-09-29T10:00:01.000Z',
    valueGp: 38_200_000,
    itemId: 13576,
    npcId: null,
    skill: null,
    level: null,
    tier: null,
    points: null,
    specialWorld: false,
    data: {},
    title: 'Loot',
    line: 'Zezima received Dragon warhammer (38.2M) from Lizardman shaman',
    icon: 'gift',
    ...overrides,
  };
}

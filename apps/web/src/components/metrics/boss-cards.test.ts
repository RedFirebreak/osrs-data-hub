import type { BossMetrics } from '@hub/server';
import { describe, expect, it } from 'vitest';
import { bossRanks, lootPerKill } from './boss-cards';

const boss = (over: Partial<BossMetrics> = {}): BossMetrics => ({
  activity: 'Vorkath',
  score: 1200,
  rank: 4321,
  modeRank: 12,
  gained: 40,
  gp: 6_000_000,
  ...over,
});

describe('boss cards', () => {
  it('show loot per kill only when both the kills and the loot of the range are known', () => {
    expect(lootPerKill(boss())).toBe(150_000);
    expect(lootPerKill(boss({ gained: 0 }))).toBeNull();
    expect(lootPerKill(boss({ gp: null }))).toBeNull();
    expect(lootPerKill(boss({ gp: 0 }))).toBeNull();
  });

  it('name the ranks, the iron one only for an iron account', () => {
    expect(bossRanks(boss(), null)).toBe('Rank 4,321');
    expect(bossRanks(boss(), 'Ironman')).toBe('Rank 4,321 · Ironman 12');
    expect(bossRanks(boss({ rank: null, modeRank: null }), 'Ironman')).toBeNull();
  });
});

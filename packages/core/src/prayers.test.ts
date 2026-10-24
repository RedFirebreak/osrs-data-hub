import { describe, expect, it } from 'vitest';
import { isRuinousPower, prayerLabel } from './prayers';

describe('prayerLabel', () => {
  it('spells the standard book as the game does', () => {
    expect(prayerLabel('PROTECT_FROM_MELEE')).toBe('Protect from Melee');
    expect(prayerLabel('PROTECT_FROM_MISSILES')).toBe('Protect from Missiles');
    expect(prayerLabel('BURST_OF_STRENGTH')).toBe('Burst of Strength');
    expect(prayerLabel('CLARITY_OF_THOUGHT')).toBe('Clarity of Thought');
    expect(prayerLabel('PIETY')).toBe('Piety');
    expect(prayerLabel('MYSTIC_VIGOUR')).toBe('Mystic Vigour');
    expect(prayerLabel('ZEAL')).toBe('Zeal');
  });

  it('drops the RP_ prefix of the Ruinous Powers, with their apostrophes', () => {
    expect(prayerLabel('RP_TRINITAS')).toBe('Trinitas');
    expect(prayerLabel('RP_ANCIENT_STRENGTH')).toBe('Ancient Strength');
    expect(prayerLabel('RP_PROTECT_ITEM')).toBe('Protect Item');
    expect(prayerLabel('RP_UMBRA_VOW')).toBe("Umbra's Vow");
    expect(prayerLabel('RP_CRUORS_VOW')).toBe("Cruor's Vow");
    expect(prayerLabel('RP_FUMUS_VOW')).toBe("Fumus' Vow");
    expect(prayerLabel('RP_GLACIES_VOW')).toBe("Glacies' Vow");
  });

  it('reads a name it has never seen by the same rule', () => {
    expect(prayerLabel('SOME_NEW_PRAYER')).toBe('Some New Prayer');
  });
});

describe('isRuinousPower', () => {
  it('is the RP_ prefix', () => {
    expect(isRuinousPower('RP_TRINITAS')).toBe(true);
    expect(isRuinousPower('PIETY')).toBe(false);
  });
});

import type { UserSettings } from '@hub/server';
import { describe, expect, it } from 'vitest';
import {
  buildPatch,
  changesToastFilter,
  chosenTypes,
  fieldErrorsFrom,
  formStateFrom,
  groupTimeZones,
  parseMinLootValue,
} from './settings-model';

const TYPES = ['loot', 'pk_loot', 'death', 'level_up'];
const MAX = 2 ** 31;

const defaults: UserSettings = {
  toast: { enabled: true, types: null, minLootValue: 0, ownAccountsOnly: false },
  timezone: 'UTC',
};

describe('formStateFrom', () => {
  it('ticks every type for "all types"', () => {
    expect(formStateFrom(defaults, TYPES)).toEqual({
      toastsEnabled: true,
      allTypes: true,
      types: TYPES,
      minLootValue: '0',
      ownAccountsOnly: false,
      timezone: 'UTC',
    });
  });

  it('keeps an explicit list', () => {
    const state = formStateFrom(
      { ...defaults, toast: { ...defaults.toast, types: ['death'] } },
      TYPES,
    );
    expect(state.allTypes).toBe(false);
    expect(state.types).toEqual(['death']);
  });
});

describe('buildPatch', () => {
  it('is empty when nothing changed', () => {
    expect(buildPatch(formStateFrom(defaults, TYPES), defaults, TYPES, MAX)).toEqual({
      patch: {},
      errors: {},
    });
  });

  it('sends only the changed fields', () => {
    const state = {
      ...formStateFrom(defaults, TYPES),
      toastsEnabled: false,
      minLootValue: '1.5m',
      timezone: 'Europe/Amsterdam',
    };
    expect(buildPatch(state, defaults, TYPES, MAX)).toEqual({
      patch: { toastsEnabled: false, toastMinLootValue: 1_500_000, timezone: 'Europe/Amsterdam' },
      errors: {},
    });
  });

  it('sends types in the canonical order, null for all, and ignores reordering', () => {
    const explicit = {
      ...formStateFrom(defaults, TYPES),
      allTypes: false,
      types: ['death', 'loot'],
    };
    expect(buildPatch(explicit, defaults, TYPES, MAX).patch).toEqual({
      toastTypes: ['loot', 'death'],
    });
    const saved: UserSettings = {
      ...defaults,
      toast: { ...defaults.toast, types: ['loot', 'death'] },
    };
    expect(buildPatch(explicit, saved, TYPES, MAX).patch).toEqual({});
    const all = { ...explicit, allTypes: true };
    expect(buildPatch(all, saved, TYPES, MAX).patch).toEqual({ toastTypes: null });
    // No types at all is a valid choice (no toasts).
    expect(buildPatch({ ...explicit, types: [] }, defaults, TYPES, MAX).patch).toEqual({
      toastTypes: [],
    });
  });

  it('reports an invalid minimum loot value instead of sending it', () => {
    const state = {
      ...formStateFrom(defaults, TYPES),
      minLootValue: 'lots',
      ownAccountsOnly: true,
    };
    const { patch, errors } = buildPatch(state, defaults, TYPES, MAX);
    expect(patch).toEqual({ toastOwnAccountsOnly: true });
    expect(errors.toastMinLootValue).toMatch(/whole number/);
  });
});

describe('chosenTypes', () => {
  it('drops types the server does not know', () => {
    const state = { ...formStateFrom(defaults, TYPES), allTypes: false, types: ['x', 'loot'] };
    expect(chosenTypes(state, TYPES)).toEqual(['loot']);
  });
});

describe('parseMinLootValue', () => {
  it.each([
    ['', 0],
    ['0', 0],
    ['1000000', 1_000_000],
    ['1,000,000', 1_000_000],
    [' 25 000 ', 25_000],
    ['100k', 100_000],
    ['1.5M', 1_500_000],
    ['2b', 2_000_000_000],
  ])('%j → %d', (raw, expected) => {
    expect(parseMinLootValue(raw, MAX)).toBe(expected);
  });

  it.each(['-1', '1.5', 'abc', '1e6', '3b', '1.2345m'])('rejects %j', (raw) => {
    expect(parseMinLootValue(raw, MAX)).toBeNull();
  });

  // A comma is a thousands separator only in whole groups of three; a decimal comma ("1,5m", as
  // Dutch and German players write it) must be refused, not read as 15M.
  it.each(['1,5m', '2,5k', '1,5', '10,00', '1,500k', '1,000.5', ',100', '100,'])(
    'refuses the ambiguous comma in %j',
    (raw) => {
      expect(parseMinLootValue(raw, MAX)).toBeNull();
    },
  );

  it.each([
    ['10,000', 10_000],
    ['1,000,000', 1_000_000],
  ])('%j is thousands separators → %d', (raw, expected) => {
    expect(parseMinLootValue(raw, MAX)).toBe(expected);
  });
});

describe('fieldErrorsFrom', () => {
  it('maps paths to fields, first message wins', () => {
    expect(
      fieldErrorsFrom([
        { path: 'toastTypes.1', message: 'Invalid option' },
        { path: 'toastTypes.2', message: 'second' },
        { path: 'timezone', message: 'must be an IANA time zone name' },
        { path: '', message: 'Unrecognized key: "x"' },
        { nope: true },
      ]),
    ).toEqual({ toastTypes: 'Invalid option', timezone: 'must be an IANA time zone name' });
    expect(fieldErrorsFrom(undefined)).toEqual({});
  });
});

describe('changesToastFilter', () => {
  it('is true for toast fields only', () => {
    expect(changesToastFilter({ timezone: 'UTC' })).toBe(false);
    expect(changesToastFilter({ toastTypes: null })).toBe(true);
    expect(changesToastFilter({ toastMinLootValue: 0 })).toBe(true);
  });
});

describe('groupTimeZones', () => {
  it('puts UTC first and groups the rest by region with readable labels', () => {
    const groups = groupTimeZones([
      'UTC',
      'Europe/Amsterdam',
      'America/Argentina/Buenos_Aires',
      'America/New_York',
      'Africa/Cairo',
    ]);
    expect(groups.map((g) => g.label)).toEqual(['UTC', 'Africa', 'America', 'Europe']);
    expect(groups[2]?.zones).toEqual([
      { value: 'America/Argentina/Buenos_Aires', label: 'Argentina / Buenos Aires' },
      { value: 'America/New_York', label: 'New York' },
    ]);
  });
});

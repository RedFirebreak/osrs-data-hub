import { DEFAULT_TOAST_FILTER, KNOWN_EVENT_TYPES } from '@hub/core';
import { auditLog, hubSettings, userSettings } from '@hub/db';
import { createTestDatabase, type TestDatabase } from '@hub/db/testing';
import { eq } from 'drizzle-orm';
import { ZodError } from 'zod';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { seedUser } from '../pairing/test-support';
import { clearDecommissionedCache, isDecommissioned, setDecommissioned } from './decommission';
import {
  MAX_TOAST_MIN_LOOT_VALUE,
  UserSettingsPatchSchema,
  canonicalTimeZone,
  getUserSettings,
  supportedTimeZones,
  updateUserSettings,
} from './user-settings';

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase('settings');
});

afterAll(async () => {
  await t.drop();
});

describe('getUserSettings', () => {
  it('returns the defaults when the user never saved settings', async () => {
    const userId = await seedUser(t.db);
    const settings = await getUserSettings(t.db, userId);
    expect(settings).toEqual({ toast: DEFAULT_TOAST_FILTER, timezone: 'UTC' });
    // A copy: callers can't mutate the shared default.
    expect(settings.toast).not.toBe(DEFAULT_TOAST_FILTER);
  });
});

describe('updateUserSettings', () => {
  it('saves a partial change on top of the defaults', async () => {
    const userId = await seedUser(t.db);
    const saved = await updateUserSettings(t.db, userId, {
      toastMinLootValue: 1_000_000,
      timezone: 'Europe/Amsterdam',
    });
    expect(saved).toEqual({
      toast: { enabled: true, types: null, minLootValue: 1_000_000, ownAccountsOnly: false },
      timezone: 'Europe/Amsterdam',
    });
    expect(await getUserSettings(t.db, userId)).toEqual(saved);
  });

  it('changes only the fields present', async () => {
    const userId = await seedUser(t.db);
    await updateUserSettings(t.db, userId, {
      toastsEnabled: false,
      toastTypes: ['loot', 'level_up'],
      toastOwnAccountsOnly: true,
      timezone: 'America/New_York',
    });
    const saved = await updateUserSettings(t.db, userId, { toastMinLootValue: 5 });
    expect(saved).toEqual({
      toast: {
        enabled: false,
        types: ['loot', 'level_up'],
        minLootValue: 5,
        ownAccountsOnly: true,
      },
      timezone: 'America/New_York',
    });
  });

  it('resets the type filter with null and allows an empty list (no toasts)', async () => {
    const userId = await seedUser(t.db);
    await updateUserSettings(t.db, userId, { toastTypes: ['death'] });
    expect((await updateUserSettings(t.db, userId, { toastTypes: null })).toast.types).toBeNull();
    expect((await updateUserSettings(t.db, userId, { toastTypes: [] })).toast.types).toEqual([]);
  });

  it('drops duplicate types and stores the canonical time zone spelling', async () => {
    const userId = await seedUser(t.db);
    const saved = await updateUserSettings(t.db, userId, {
      toastTypes: ['loot', 'loot', 'pk_loot'],
      timezone: 'europe/amsterdam',
    });
    expect(saved.toast.types).toEqual(['loot', 'pk_loot']);
    expect(saved.timezone).toBe('Europe/Amsterdam');
  });

  it('accepts an empty change', async () => {
    const userId = await seedUser(t.db);
    expect(await updateUserSettings(t.db, userId, {})).toEqual({
      toast: DEFAULT_TOAST_FILTER,
      timezone: 'UTC',
    });
    const rows = await t.db.select().from(userSettings).where(eq(userSettings.userId, userId));
    expect(rows).toHaveLength(1);
  });

  it('throws a ZodError and writes nothing for invalid input', async () => {
    const userId = await seedUser(t.db);
    await expect(updateUserSettings(t.db, userId, { timezone: 'Mars/Olympus' })).rejects.toThrow(
      ZodError,
    );
    const rows = await t.db.select().from(userSettings).where(eq(userSettings.userId, userId));
    expect(rows).toHaveLength(0);
  });
});

describe('UserSettingsPatchSchema', () => {
  const ok = (patch: unknown) => UserSettingsPatchSchema.safeParse(patch).success;
  const issuePath = (patch: unknown) =>
    UserSettingsPatchSchema.safeParse(patch).error?.issues.map((i) => i.path.join('.'));

  it('accepts every known event type', () => {
    expect(ok({ toastTypes: [...KNOWN_EVENT_TYPES] })).toBe(true);
  });

  it('rejects unknown keys and non-objects', () => {
    expect(ok({ toastsEnabled: true, extra: 1 })).toBe(false);
    expect(ok(null)).toBe(false);
    expect(ok([])).toBe(false);
    expect(ok('{}')).toBe(false);
  });

  it('validates each field', () => {
    expect(issuePath({ toastsEnabled: 'yes' })).toEqual(['toastsEnabled']);
    expect(issuePath({ toastTypes: ['loot', 'levelUp'] })).toEqual(['toastTypes.1']);
    expect(issuePath({ toastTypes: 'loot' })).toEqual(['toastTypes']);
    expect(issuePath({ toastMinLootValue: -1 })).toEqual(['toastMinLootValue']);
    expect(issuePath({ toastMinLootValue: 1.5 })).toEqual(['toastMinLootValue']);
    expect(issuePath({ toastMinLootValue: '100' })).toEqual(['toastMinLootValue']);
    expect(issuePath({ toastMinLootValue: MAX_TOAST_MIN_LOOT_VALUE + 1 })).toEqual([
      'toastMinLootValue',
    ]);
    expect(issuePath({ toastOwnAccountsOnly: 1 })).toEqual(['toastOwnAccountsOnly']);
    expect(issuePath({ timezone: null })).toEqual(['timezone']);
  });

  it('accepts the bounds of the minimum loot value', () => {
    expect(ok({ toastMinLootValue: 0 })).toBe(true);
    expect(ok({ toastMinLootValue: 2 ** 31 })).toBe(true);
  });

  it.each(['UTC', 'Etc/UTC', 'Europe/Amsterdam', 'America/Argentina/Buenos_Aires', 'Etc/GMT+1'])(
    'accepts the time zone %s',
    (timezone) => {
      expect(ok({ timezone })).toBe(true);
    },
  );

  it.each(['', 'Mars/Olympus', '+01:00', '-01', 'UTC+1', 'Z', 'Europe/../etc', 'x'.repeat(65)])(
    'rejects the time zone %j',
    (timezone) => {
      expect(issuePath({ timezone })).toEqual(['timezone']);
    },
  );
});

describe('time zone helpers', () => {
  it('canonicalizes known names and rejects offsets', () => {
    expect(canonicalTimeZone('utc')).toBe('UTC');
    expect(canonicalTimeZone('Europe/Amsterdam')).toBe('Europe/Amsterdam');
    expect(canonicalTimeZone('+01:00')).toBeNull();
    expect(canonicalTimeZone('Nowhere/Special')).toBeNull();
  });

  it('lists UTC first and every entry validates', () => {
    const zones = supportedTimeZones();
    expect(zones[0]).toBe('UTC');
    expect(new Set(zones).size).toBe(zones.length);
    expect(zones.length).toBeGreaterThan(300);
    expect(zones.every((z) => canonicalTimeZone(z) !== null)).toBe(true);
  });
});

describe('decommission switch', () => {
  afterEach(() => {
    vi.useRealTimers();
    clearDecommissionedCache();
  });

  it('is off without a row', async () => {
    clearDecommissionedCache();
    expect(await isDecommissioned(t.db)).toBe(false);
  });

  it('turns on and off at once in this process, with an audit entry each time', async () => {
    const admin = await seedUser(t.db, { isAdmin: true });
    expect(await isDecommissioned(t.db)).toBe(false); // cached "off"

    await setDecommissioned(t.db, { value: true, actorUserId: admin });
    expect(await isDecommissioned(t.db)).toBe(true);
    const [row] = await t.db
      .select()
      .from(hubSettings)
      .where(eq(hubSettings.key, 'decommissioned'));
    expect(row).toMatchObject({ value: true, updatedBy: admin });

    await setDecommissioned(t.db, { value: false, actorUserId: admin });
    expect(await isDecommissioned(t.db)).toBe(false);

    const audits = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'hub.decommissioned'));
    expect(audits.map((a) => a.meta)).toEqual([{ value: true }, { value: false }]);
    expect(audits.every((a) => a.actorUserId === admin)).toBe(true);
  });

  it('caches the value for 10 seconds', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-28T12:00:00Z'));
    await t.db.delete(hubSettings).where(eq(hubSettings.key, 'decommissioned'));
    expect(await isDecommissioned(t.db)).toBe(false);

    // Changed behind the cache's back (e.g. by another process).
    await t.db.insert(hubSettings).values({ key: 'decommissioned', value: true });
    vi.setSystemTime(new Date('2026-09-28T12:00:09.999Z'));
    expect(await isDecommissioned(t.db)).toBe(false);
    vi.setSystemTime(new Date('2026-09-28T12:00:10Z'));
    expect(await isDecommissioned(t.db)).toBe(true);
  });

  it('only treats JSON true as on', async () => {
    for (const value of ['true', 1, { on: true }, false]) {
      await t.db
        .insert(hubSettings)
        .values({ key: 'decommissioned', value })
        .onConflictDoUpdate({ target: hubSettings.key, set: { value } });
      clearDecommissionedCache();
      expect(await isDecommissioned(t.db)).toBe(false);
    }
  });
});

import { DEFAULT_MAP_LINK } from '@hub/core';
import { auditLog, hubSettings } from '@hub/db';
import { createTestDatabase, type TestDatabase } from '@hub/db/testing';
import { desc, eq } from 'drizzle-orm';
import { ZodError } from 'zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedUser, type SeededUser } from '../accounts/test-support';
import { getMapLink, setMapLink } from './map-link';

let t: TestDatabase;
let admin: SeededUser;

beforeAll(async () => {
  t = await createTestDatabase('map-link');
  admin = await seedUser(t.db);
});

afterAll(async () => {
  await t.drop();
});

beforeEach(async () => {
  await t.db.delete(hubSettings).where(eq(hubSettings.key, 'map_link'));
});

async function store(value: unknown): Promise<void> {
  await t.db.insert(hubSettings).values({ key: 'map_link', value });
}

describe('getMapLink', () => {
  it('is off without a stored value', async () => {
    expect(await getMapLink(t.db)).toEqual(DEFAULT_MAP_LINK);
  });

  it('reads a stored value leniently, and never turns on an unusable address', async () => {
    await store({ enabled: true, url: 'https://map.example.com/', extra: 1 });
    expect(await getMapLink(t.db)).toEqual({ enabled: true, url: 'https://map.example.com/' });

    await t.db.delete(hubSettings).where(eq(hubSettings.key, 'map_link'));
    await store({ enabled: true, url: 'javascript:alert(1)' });
    expect(await getMapLink(t.db)).toEqual({ enabled: false, url: null });

    await t.db.delete(hubSettings).where(eq(hubSettings.key, 'map_link'));
    await store({ enabled: true });
    expect(await getMapLink(t.db)).toEqual({ enabled: false, url: null });

    await t.db.delete(hubSettings).where(eq(hubSettings.key, 'map_link'));
    await store('on');
    expect(await getMapLink(t.db)).toEqual(DEFAULT_MAP_LINK);
  });
});

describe('setMapLink', () => {
  it('stores the link normalised and audits the change', async () => {
    const link = await setMapLink(t.db, {
      link: { enabled: true, url: '  https://Map.Example.com  ' },
      actorUserId: admin.id,
    });
    expect(link).toEqual({ enabled: true, url: 'https://map.example.com/' });
    expect(await getMapLink(t.db)).toEqual(link);
    const [entry] = await t.db
      .select({ meta: auditLog.meta, actor: auditLog.actorUserId, target: auditLog.targetId })
      .from(auditLog)
      .where(eq(auditLog.action, 'hub.map_link_changed'))
      .orderBy(desc(auditLog.id))
      .limit(1);
    expect(entry).toEqual({ meta: link, actor: admin.id, target: 'map_link' });
  });

  it('keeps the address while the link is off, and an empty one is none', async () => {
    const off = await setMapLink(t.db, {
      link: { enabled: false, url: 'https://map.example.com/' },
      actorUserId: admin.id,
    });
    expect(off).toEqual({ enabled: false, url: 'https://map.example.com/' });
    const cleared = await setMapLink(t.db, {
      link: { enabled: false, url: '  ' },
      actorUserId: admin.id,
    });
    expect(cleared).toEqual({ enabled: false, url: null });
  });

  it('refuses an address that is not http or https, and turning on without one', async () => {
    for (const link of [
      { enabled: false, url: 'javascript:alert(1)' },
      { enabled: false, url: 'map.example.com' },
      { enabled: true, url: null },
      { enabled: true, url: '' },
    ]) {
      await expect(setMapLink(t.db, { link, actorUserId: admin.id })).rejects.toThrow(ZodError);
    }
    expect(await getMapLink(t.db)).toEqual(DEFAULT_MAP_LINK);
  });
});

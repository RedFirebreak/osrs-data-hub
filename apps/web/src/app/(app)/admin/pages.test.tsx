/**
 * The admin pages as a Server Component render sees them (next/headers stubbed with the request's
 * headers, next/navigation's client hooks stubbed, as in ../pages.test.tsx): 404 for everyone but
 * admins, and each page's markup with seeded data (secrets never in the configuration page).
 */
import { randomUUID } from 'node:crypto';
import { auditLog, devices, rawPayloads, users } from '@hub/db';
import {
  createServiceKey,
  getMetrics,
  revokeServiceKey,
  setDecommissioned,
  setGuildFeedFilter,
} from '@hub/server';
import { eq } from 'drizzle-orm';
import { renderToReadableStream } from 'react-dom/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { TEST_AUTH_SECRET, withTestDb, type WebTestContext } from '@/lib/test-utils';
import AuditPage from './audit/page';
import ConfigPage from './config/page';
import DecommissionPage from './decommission/page';
import DevicesPage from './devices/page';
import IngestPage from './ingest/page';
import IntegrationsPage from './integrations/page';
import AdminLayout from './layout';
import UsersPage from './page';
import PayloadsPage from './payloads/page';
import SettingsPage from './settings/page';

const page = vi.hoisted(() => ({ headers: new Headers() }));

vi.mock('next/headers', () => ({
  headers: () => Promise.resolve(page.headers),
  cookies: () =>
    Promise.resolve({ get: () => undefined, getAll: () => [], has: () => false, set: () => {} }),
}));

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useRouter: () => ({ refresh() {}, push() {}, replace() {}, back() {}, prefetch() {} }),
  usePathname: () => '/admin',
}));

const BOT_TOKEN = 'bot-token-SECRET-value.abc';
const METRICS_TOKEN = 'metrics-token-SECRET-value';

let ctx: WebTestContext;
let adminId: string;
let adminCookie: string;

beforeAll(async () => {
  ctx = await withTestDb({
    label: 'adminpages',
    env: { DISCORD_BOT_TOKEN: BOT_TOKEN, METRICS_TOKEN },
  });
  adminId = await ctx.seedUser({ name: 'Ada Admin', isAdmin: true });
  adminCookie = await ctx.signIn(adminId);
});
beforeEach(() => {
  page.headers = new Headers({ cookie: adminCookie });
});
afterAll(() => ctx.cleanup());

function searchParams(params: Record<string, string> = {}) {
  return { params: Promise.resolve({}), searchParams: Promise.resolve(params) };
}

/**
 * The page's HTML without React's text separators (`<!-- -->`, so adjacent text reads as written),
 * or "redirect:<path>" / "notFound".
 */
async function render(pageFn: () => Promise<React.ReactNode>): Promise<string> {
  try {
    const element = await pageFn();
    const stream = await renderToReadableStream(<TooltipProvider>{element}</TooltipProvider>);
    await stream.allReady;
    return (await new Response(stream).text()).replaceAll('<!-- -->', '');
  } catch (err) {
    const digest = (err as { digest?: unknown }).digest;
    if (typeof digest === 'string' && digest.startsWith('NEXT_REDIRECT')) {
      return `redirect:${digest.split(';')[2]}`;
    }
    if (digest === 'NEXT_HTTP_ERROR_FALLBACK;404') return 'notFound';
    throw err;
  }
}

/** React escapes apostrophes in text; compare against the markup's form. */
function html(text: string): string {
  return text.replace(/'/g, '&#x27;');
}

const PAGES: [string, () => Promise<React.ReactNode>][] = [
  ['layout', () => AdminLayout({ children: <p>inside</p> })],
  ['users', () => UsersPage()],
  ['devices', () => DevicesPage(searchParams() as PageProps<'/admin/devices'>)],
  ['ingest', () => IngestPage()],
  ['integrations', () => IntegrationsPage()],
  ['payloads', () => PayloadsPage(searchParams() as PageProps<'/admin/payloads'>)],
  ['audit', () => AuditPage()],
  ['config', () => ConfigPage()],
  ['settings', () => SettingsPage()],
  ['decommission', () => DecommissionPage()],
];

describe('access', () => {
  it('answers 404 to signed-in members and sends signed-out visitors to /login', async () => {
    const member = await ctx.seedUser({ name: 'Just A Member' });
    page.headers = new Headers({ cookie: await ctx.signIn(member) });
    for (const [name, fn] of PAGES) {
      expect(await render(fn), name).toBe('notFound');
    }
    page.headers = new Headers();
    for (const [name, fn] of PAGES) {
      expect(await render(fn), name).toBe('redirect:/login');
    }
    // An admin in grace (offboarded) whose session somehow survived counts as signed out.
    const graceAdmin = await ctx.seedUser({ name: 'Grace Admin', isAdmin: true });
    page.headers = new Headers({ cookie: await ctx.signIn(graceAdmin) });
    await ctx.t.db.update(users).set({ status: 'grace' }).where(eq(users.id, graceAdmin));
    for (const [name, fn] of PAGES) {
      expect(await render(fn), name).toBe('redirect:/login');
    }
  });

  it('renders every page for an admin', async () => {
    for (const [name, fn] of PAGES) {
      const out = await render(fn);
      expect(out, name).not.toBe('notFound');
      expect(out.startsWith('redirect:'), name).toBe(false);
    }
  });
});

describe('users page', () => {
  it('lists users with status, grace and failed checks, and offers the right actions', async () => {
    const leaving = await ctx.seedUser({ name: 'Gone Gary', status: 'grace' });
    await ctx.t.db
      .update(users)
      .set({
        offboardReason: 'left_guild',
        graceUntil: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000 - 60_000),
      })
      .where(eq(users.id, leaving));
    const flaky = await ctx.seedUser({ name: 'Flaky Fiona' });
    await ctx.t.db.update(users).set({ verifyFailures: 3 }).where(eq(users.id, flaky));

    const out = await render(() => UsersPage());
    expect(out).toContain('Ada Admin');
    expect(out).toContain('Gone Gary');
    expect(out).toContain('Left the Discord server');
    expect(out).toContain('10 days left');
    // Once in the "Discord check" column (md and up), once in the user cell (narrow screens).
    expect(out.split('3 failed Discord checks in a row')).toHaveLength(3);
    expect(out).toContain('Restore');
    expect(out).toContain('Offboard');
  });
});

describe('devices page', () => {
  it('lists devices with their owner and filters by status', async () => {
    const owner = await ctx.seedUser({ name: 'Device Dora' });
    await ctx.seedDevice(owner, { label: 'Laptop upstairs' });
    const old = await ctx.seedDevice(owner, { label: 'Old desktop' });
    await ctx.t.db
      .update(devices)
      .set({ revokedAt: new Date(), revokedReason: 'user' })
      .where(eq(devices.id, old.id));

    const all = await render(() => DevicesPage(searchParams() as PageProps<'/admin/devices'>));
    expect(all).toContain('Laptop upstairs');
    expect(all).toContain('Old desktop');
    expect(all).toContain('Device Dora');
    expect(all).toContain('Revoked by its owner');

    const revoked = await render(() =>
      DevicesPage(searchParams({ show: 'revoked' }) as PageProps<'/admin/devices'>),
    );
    expect(revoked).toContain('Old desktop');
    expect(revoked).not.toContain('Laptop upstairs');
  });
});

describe('ingest and raw payloads', () => {
  let deviceId: string;

  beforeAll(async () => {
    const owner = await ctx.seedUser({ name: 'Noisy Nora' });
    deviceId = (await ctx.seedDevice(owner, { label: 'Gaming PC' })).id;
    const now = Date.now();
    await ctx.t.db.insert(rawPayloads).values([
      {
        receivedAt: new Date(now - 30_000),
        deviceId,
        status: 200,
        pluginVersion: '1.5.1',
        meta: { inserted: 2 },
        body: '{"player":{"name":"Zezima"},"location":{"x":3222,"y":3218}}',
      },
      {
        receivedAt: new Date(now - 90_000),
        deviceId,
        status: 503,
        pluginVersion: '1.5.1',
        meta: { skippedSections: ['player.inventory'], error: 'unavailable' },
        body: '{}',
      },
    ]);
  });

  it('shows totals, statuses and the noisy device', async () => {
    const out = await render(() => IngestPage());
    expect(out).toContain('Payloads per minute');
    expect(out).toContain('Rejected payloads (unknown or revoked tokens');
    expect(out).toContain('Unavailable');
    expect(out).toContain('player.inventory');
    expect(out).toContain('Gaming PC');
    expect(out).toContain('Noisy Nora');
  });

  it('shows 401s and 429s, which are never archived, from the ingest counters (handoff §12)', async () => {
    const { ingestPayloads } = getMetrics();
    ingestPayloads.inc({ status: '401' }, 1234);
    ingestPayloads.inc({ status: '429' }, 4321);
    const out = await render(() => IngestPage());
    expect(out).toContain('Since the hub started');
    expect(out).toContain('1,234');
    expect(out).toContain('4,321');
    expect(out).toContain('Rate limited');
    expect(out).toContain('Unauthorized');
  });

  it('lists payloads without their bodies, filtered by device and status', async () => {
    const out = await render(() => PayloadsPage(searchParams() as PageProps<'/admin/payloads'>));
    expect(out).toContain('2 events stored');
    expect(out).toContain('error: unavailable');
    expect(out).toContain('Gaming PC');
    // Bodies (they hold coordinates) are only ever fetched on demand.
    expect(out).not.toContain('3222');
    expect(out).not.toContain('Zezima');

    const only503 = await render(() =>
      PayloadsPage(
        searchParams({ device: deviceId, status: '503' }) as PageProps<'/admin/payloads'>,
      ),
    );
    expect(only503).toContain('error: unavailable');
    expect(only503).not.toContain('2 events stored');

    const none = await render(() =>
      PayloadsPage(searchParams({ device: randomUUID() }) as PageProps<'/admin/payloads'>),
    );
    expect(none).toContain('No payloads found');
  });
});

describe('audit, configuration, settings and decommission pages', () => {
  it('shows audit entries with their actor', async () => {
    await ctx.t.db.insert(auditLog).values({
      actorUserId: adminId,
      action: 'device.revoked',
      targetType: 'device',
      targetId: randomUUID(),
      meta: { reason: 'admin' },
    });
    const out = await render(() => AuditPage());
    expect(out).toContain('Device revoked');
    expect(out).toContain('Ada Admin');
  });

  it('never shows a secret on the configuration page', async () => {
    const out = await render(() => ConfigPage());
    expect(out).toContain('DISCORD_BOT_TOKEN');
    expect(out).toContain('METRICS_TOKEN');
    for (const secret of [BOT_TOKEN, METRICS_TOKEN, TEST_AUTH_SECRET, 'test-client-secret']) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain(html('Test Hub'));
  });

  it('shows the switch off, and the banner once decommissioned', async () => {
    const off = await render(() => DecommissionPage());
    expect(off).toContain('Danger zone');
    expect(off).not.toContain('is decommissioned');
    await setDecommissioned(ctx.t.db, { value: true, actorUserId: adminId });
    try {
      const on = await render(() => DecommissionPage());
      expect(on).toContain('Test Hub is decommissioned');
    } finally {
      await setDecommissioned(ctx.t.db, { value: false, actorUserId: adminId });
    }
  });

  it('shows the stored guild feed filter on the settings page', async () => {
    const before = await render(() => SettingsPage());
    expect(before).toContain('Guild activity');
    expect(before).toContain('value="0"');
    await setGuildFeedFilter(ctx.t.db, {
      filter: { minLootValue: 25_000, showVirtualLevels: true },
      actorUserId: adminId,
    });
    const after = await render(() => SettingsPage());
    expect(after).toContain('value="25000"');
    expect(after).toMatch(/role="switch"[^>]*aria-checked="true"/);
  });
});

describe('integrations page', () => {
  it('lists service keys masked with their creator and rate limit, active ones with Revoke', async () => {
    const empty = await render(() => IntegrationsPage());
    expect(empty).toContain('No integration keys yet');
    expect(empty).toContain('Create integration key');

    const actor = { userId: adminId, status: 'active' as const, isAdmin: true };
    const live = await createServiceKey(ctx.t.db, {
      actor,
      input: { name: 'Guild live map', categories: ['activity', 'location_live'] },
    });
    const old = await createServiceKey(ctx.t.db, {
      actor,
      input: { name: 'Old bot', categories: ['events'], rateLimitPerMinute: 60 },
    });
    await revokeServiceKey(ctx.t.db, { actor, keyId: old.info.id });

    const out = await render(() => IntegrationsPage());
    expect(out).toContain('Guild live map');
    expect(out).toContain(`ohub_${live.info.prefix}_…`);
    expect(out).not.toContain(live.key.slice(16));
    expect(out).not.toContain(old.key.slice(16));
    expect(out).toContain('Ada Admin');
    expect(out).toContain('Every account shared with the guild');
    expect(out).toContain('Active keys');
    expect(out).toContain('Revoked and expired keys');
    expect(out).toContain('Old bot');
    expect(out).toContain('Revoke');
    expect(out).toContain('600');
    expect(out).toContain('60');
  });
});

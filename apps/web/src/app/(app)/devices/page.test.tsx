/**
 * The Devices page as a Server Component render sees it (next/headers stubbed with the request's
 * headers, next/navigation's client hooks stubbed, as in ../pages.test.tsx): who gets through, that
 * only the signed-in user's devices are listed, and the markup.
 */
import { randomUUID } from 'node:crypto';
import { accountLinks, deviceAccounts, devices, osrsAccounts } from '@hub/db';
import { eq } from 'drizzle-orm';
import { renderToReadableStream } from 'react-dom/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { withTestDb, type WebTestContext } from '@/lib/test-utils';
import DevicesPage from './page';

const page = vi.hoisted(() => ({ headers: new Headers() }));

vi.mock('next/headers', () => ({
  headers: () => Promise.resolve(page.headers),
  cookies: () =>
    Promise.resolve({ get: () => undefined, getAll: () => [], has: () => false, set: () => {} }),
}));

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useRouter: () => ({ refresh() {}, push() {}, replace() {}, back() {}, prefetch() {} }),
  usePathname: () => '/devices',
}));

let ctx: WebTestContext;

beforeAll(async () => {
  ctx = await withTestDb({ label: 'devicespage' });
});
beforeEach(() => {
  page.headers = new Headers();
});
afterAll(() => ctx.cleanup());

async function signIn(opts: Parameters<WebTestContext['seedUser']>[0] = {}): Promise<string> {
  const userId = await ctx.seedUser(opts);
  page.headers = new Headers({ cookie: await ctx.signIn(userId) });
  return userId;
}

/** The page's HTML, or "redirect:<path>". */
async function render(pageFn: () => Promise<React.ReactNode>): Promise<string> {
  try {
    const element = await pageFn();
    const stream = await renderToReadableStream(<TooltipProvider>{element}</TooltipProvider>);
    await stream.allReady;
    return await new Response(stream).text();
  } catch (err) {
    const digest = (err as { digest?: unknown }).digest;
    if (typeof digest === 'string' && digest.startsWith('NEXT_REDIRECT')) {
      return `redirect:${digest.split(';')[2]}`;
    }
    throw err;
  }
}

/** An account owned by `ownerUserId` and reported by `deviceId`. */
async function reportedAccount(name: string, ownerUserId: string, deviceId: string) {
  const publicId = randomUUID().replace(/-/g, '').slice(0, 12);
  const [row] = await ctx.t.db
    .insert(osrsAccounts)
    .values({
      publicId,
      accountHash: randomUUID(),
      currentName: name,
      nameNormalized: name.toLowerCase(),
      ownerUserId,
    })
    .returning({ id: osrsAccounts.id });
  const accountId = row!.id;
  await ctx.t.db.insert(accountLinks).values({ accountId, userId: ownerUserId, role: 'owner' });
  await ctx.t.db.insert(deviceAccounts).values({ deviceId, accountId });
  return publicId;
}

describe('devices page', () => {
  it('sends signed-out and grace users to /login', async () => {
    expect(await render(() => DevicesPage())).toBe('redirect:/login');
    await signIn({ status: 'grace' });
    expect(await render(() => DevicesPage())).toBe('redirect:/login');
  });

  it('points a user without devices at the wizard', async () => {
    await signIn();
    const html = await render(() => DevicesPage());
    expect(html).toMatch(/<h1[^>]*>Devices<\/h1>/);
    expect(html).toMatch(/<h2[^>]*>No devices yet<\/h2>/);
    expect(html).toContain('href="/onboarding"');
    expect(html).toContain('Add your first device');
  });

  it("lists the user's own devices with version, status, accounts and revoked ones apart", async () => {
    const other = await ctx.seedUser();
    await ctx.seedDevice(other, { label: 'Not mine' });
    const me = await signIn();

    const desktop = await ctx.seedDevice(me, { label: 'Desktop PC' });
    await ctx.t.db
      .update(devices)
      .set({ pluginVersion: '1.5.1', lastSeenAt: new Date(Date.now() - 5 * 60_000) })
      .where(eq(devices.id, desktop.id));
    const publicId = await reportedAccount('Zezima', me, desktop.id);

    const laptop = await ctx.seedDevice(me, { label: 'Old laptop' });
    await ctx.t.db
      .update(devices)
      .set({ pluginVersion: '1.4', outdatedAt: new Date() })
      .where(eq(devices.id, laptop.id));

    const gone = await ctx.seedDevice(me, { label: 'Sold PC' });
    await ctx.t.db
      .update(devices)
      .set({ revokedAt: new Date(), revokedReason: 'user' })
      .where(eq(devices.id, gone.id));

    const html = await render(() => DevicesPage());
    expect(html).not.toContain('Not mine');
    expect(html).toMatch(/<h2[^>]*>Connected devices/);
    expect(html).toMatch(/<h2[^>]*>Revoked devices/);
    expect(html).toMatch(/<h3[^>]*>Desktop PC<\/h3>/);
    expect(html).toContain('1.5.1');
    expect(html).toContain(`href="/accounts/${publicId}"`);
    expect(html).toContain('5 min ago');
    // The outdated device: version, status and the fix in the badge's screen-reader text.
    expect(html).toContain('1.4');
    expect(html).toContain('Update HA Exporter: restart RuneLite');
    expect(html).toContain('Revoked by you');
    // Revoke for the two connected devices only.
    expect(html.match(/>Revoke<span class="sr-only">/g)).toHaveLength(2);
    expect(html).toContain('href="/onboarding"');
    // Nothing secret on the page.
    expect(html).not.toContain(desktop.token);
  });
});

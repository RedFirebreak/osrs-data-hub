/**
 * The signed-in pages of this group (dashboard, settings) as a Server Component render sees them:
 * next/headers stubbed with the request's headers (like lib/session-pages.test.ts) and next/navigation's
 * client hooks stubbed for the client components rendered to markup. Checks who gets through, that a
 * page shows only the signed-in user's data, and the markup (headings, the empty state).
 */
import { randomUUID } from 'node:crypto';
import { accountLinks, accountSharing, latestState, osrsAccounts, userSettings } from '@hub/db';
import { eq } from 'drizzle-orm';
import { renderToReadableStream } from 'react-dom/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { withTestDb, type WebTestContext } from '@/lib/test-utils';
import AppLayout from './layout';
import DashboardPage from './page';
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
  usePathname: () => '/',
}));

let ctx: WebTestContext;

beforeAll(async () => {
  ctx = await withTestDb({ label: 'shellpages' });
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

/** The page's HTML (async Server Components included), or "redirect:<path>". */
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

/** An account owned by `ownerUserId`, online right now (LOGGED_IN, seen a second ago). */
async function seedOnlineAccount(name: string, ownerUserId: string): Promise<number> {
  const [row] = await ctx.t.db
    .insert(osrsAccounts)
    .values({
      publicId: randomUUID().replace(/-/g, '').slice(0, 12),
      accountHash: randomUUID(),
      currentName: name,
      nameNormalized: name.toLowerCase(),
      ownerUserId,
    })
    .returning({ id: osrsAccounts.id });
  const accountId = row!.id;
  await ctx.t.db.insert(accountLinks).values({ accountId, userId: ownerUserId, role: 'owner' });
  await ctx.t.db.insert(latestState).values({
    accountId,
    lastSeen: new Date(Date.now() - 1_000),
    gameState: 'LOGGED_IN',
    tickDelay: 0,
    world: 302,
  });
  return accountId;
}

describe('app layout', () => {
  it('sends signed-out and grace users to /login', async () => {
    expect(await render(() => AppLayout({ children: <p>secret</p> }))).toBe('redirect:/login');
    await signIn({ status: 'grace' });
    expect(await render(() => AppLayout({ children: <p>secret</p> }))).toBe('redirect:/login');
  });

  it('shows the player navigation, and puts nothing private in the page', async () => {
    await signIn({ name: 'Plain' });
    const plain = await render(() => AppLayout({ children: <p>content</p> }));
    expect(plain).toContain('<p>content</p>');
    expect(plain).toContain('Plain');
    expect(plain).toMatch(/<a[^>]*aria-current="page"[^>]*href="\/"[^>]*>Home<\/a>/);
    expect(plain).toMatch(/<a[^>]*href="\/guild"[^>]*>Guild<\/a>/);
    // The set-up pages live in the avatar menu (closed until opened), not in the bar.
    for (const href of ['/devices', '/api-keys', '/settings', '/admin']) {
      expect(plain).not.toContain(`href="${href}"`);
    }
    expect(plain).not.toContain('@discord.invalid');
    expect(plain).toMatch(/href="#main"/);
    expect(plain).toMatch(/<main id="main"/);
  });
});

describe('dashboard', () => {
  it('sends signed-out and grace users to /login', async () => {
    expect(await render(() => DashboardPage())).toBe('redirect:/login');
    await signIn({ status: 'grace' });
    expect(await render(() => DashboardPage())).toBe('redirect:/login');
  });

  it('points a user without accounts at the wizard, under proper headings', async () => {
    await signIn({ name: 'Newbie' });
    const html = await render(() => DashboardPage());
    expect(html).toMatch(/<h1[^>]*>Dashboard<\/h1>/);
    expect(html).toContain('Welcome back, Newbie.');
    expect(html).toMatch(/<h2[^>]*>[^<]*<span[^>]*>.*Online now<\/h2>/);
    expect(html).toMatch(/<h2[^>]*>Connect RuneLite to see your accounts<\/h2>/);
    expect(html).toContain('href="/onboarding"');
  });
});

describe('dashboard with accounts', () => {
  it("shows cards for the viewer's own accounts only, and online accounts it may see", async () => {
    const other = await ctx.seedUser();
    await seedOnlineAccount('Guildie', other);
    const secret = await seedOnlineAccount('Hermit', other);
    // Online status shared with nobody.
    await ctx.t.db
      .insert(accountSharing)
      .values({ accountId: secret, category: 'activity', audience: 'private' });
    const me = await signIn();
    await seedOnlineAccount('Zezima', me);
    // An account the viewer plays too, hidden because its owner is offboarded (handoff §10).
    const hidden = await seedOnlineAccount('Ghost', other);
    await ctx.t.db
      .update(osrsAccounts)
      .set({ status: 'hidden' })
      .where(eq(osrsAccounts.id, hidden));
    await ctx.t.db.insert(accountLinks).values({ accountId: hidden, userId: me });

    const html = await render(() => DashboardPage());
    expect(html).toMatch(/<h2[^>]*>Your accounts<\/h2>/);
    expect(html).toMatch(/<h3[^>]*><a[^>]*>Zezima<\/a><\/h3>/);
    expect(html).not.toMatch(/<h3[^>]*><a[^>]*>Guildie<\/a><\/h3>/);
    expect(html).toContain('>Guildie</span>'); // in "Online now"
    expect(html).not.toContain('Hermit');
    expect(html).not.toContain('Ghost');
    expect(html).not.toContain('Connect RuneLite to see your accounts');
  });
});

describe('settings page', () => {
  it('sends signed-out and grace users to /login', async () => {
    expect(await render(() => SettingsPage())).toBe('redirect:/login');
    await signIn({ status: 'grace' });
    expect(await render(() => SettingsPage())).toBe('redirect:/login');
  });

  it("shows the signed-in user's own settings, with a heading per section", async () => {
    const other = await ctx.seedUser();
    await ctx.t.db.insert(userSettings).values({ userId: other, timezone: 'Asia/Tokyo' });
    await signIn();
    const html = await render(() => SettingsPage());
    expect(html).toMatch(/<h1[^>]*>Settings<\/h1>/);
    for (const title of ['Live toasts', 'Time zone', 'What gets sent to the hub']) {
      expect(html).toMatch(new RegExp(`<h2[^>]*>${title}</h2>`));
    }
    expect(html).toMatch(/<h2[^>]*>Delete my data/);
    // The default time zone, not the other user's.
    expect(html).toMatch(/<option value="UTC" selected="">/);
    expect(html).not.toMatch(/<option value="Asia\/Tokyo" selected="">/);
    expect(html).toMatch(/role="group" aria-label="Quick values"/);
  });
});

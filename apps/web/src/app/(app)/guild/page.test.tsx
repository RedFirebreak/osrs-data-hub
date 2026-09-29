/**
 * The guild page as a Server Component render sees it: who gets through, members with the accounts
 * the viewer can see, the activity feed (private events left out) and the gains leaderboards.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToReadableStream } from 'react-dom/server';
import { accountSeeder, skillMap, type AccountSeeder } from '@/app/api/app/accounts/test-seed';
import { TooltipProvider } from '@/components/ui/tooltip';
import { withTestDb, type WebTestContext } from '@/lib/test-utils';
import GuildPage from './page';

const page = vi.hoisted(() => ({ headers: new Headers() }));

vi.mock('next/headers', () => ({
  headers: () => Promise.resolve(page.headers),
  cookies: () =>
    Promise.resolve({ get: () => undefined, getAll: () => [], has: () => false, set: () => {} }),
}));

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useRouter: () => ({ refresh() {}, push() {}, replace() {}, back() {}, prefetch() {} }),
  usePathname: () => '/guild',
}));

let ctx: WebTestContext;
let seed: AccountSeeder;

beforeAll(async () => {
  ctx = await withTestDb({ label: 'guildpage' });
  seed = accountSeeder(ctx.t.db);
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

async function render(): Promise<string> {
  try {
    const element = await GuildPage();
    const stream = await renderToReadableStream(<TooltipProvider>{element}</TooltipProvider>);
    await stream.allReady;
    return (await new Response(stream).text()).replace(/<!-- -->/g, '');
  } catch (err) {
    const digest = (err as { digest?: unknown }).digest;
    if (typeof digest === 'string' && digest.startsWith('NEXT_REDIRECT')) {
      return `redirect:${digest.split(';')[2]}`;
    }
    throw err;
  }
}

describe('guild page', () => {
  it('sends signed-out and grace users to /login', async () => {
    expect(await render()).toBe('redirect:/login');
    await signIn({ status: 'grace' });
    expect(await render()).toBe('redirect:/login');
  });

  it('shows empty states when nothing is shared yet', async () => {
    await signIn();
    const html = await render();
    expect(html).toMatch(/<h1[^>]*>Guild<\/h1>/);
    for (const title of ['Leaderboards', 'Activity', 'Members']) {
      expect(html).toMatch(new RegExp(`<h2[^>]*>${title}</h2>`));
    }
    expect(html).toContain('No accounts are shared with you yet.');
    expect(html).toContain('Nobody has gained Overall XP today yet.');
  });

  it('lists members with their visible accounts, the feed and the leaderboards', async () => {
    const alice = await ctx.seedUser({ name: 'Alice' });
    const bob = await ctx.seedUser({ name: 'Bob' });
    const now = Date.now();
    const main = await seed.account({ owner: alice, name: 'Zezima' });
    await seed.latestState(main.id, {
      lastSeen: new Date(now - 1_000),
      gameState: 'LOGGED_IN',
      tickDelay: 0,
      world: 302,
      skills: skillMap({ Attack: [2_000_000, 80] }),
      skillsUpdatedAt: new Date(now),
    });
    // XP half an hour ago: 1.5M → a 500K gain in Attack and Overall on every board.
    const hourAgo = new Date(Math.floor((now - 30 * 60_000) / 300_000) * 300_000 - 300_000);
    await seed.xp(main.id, [
      ['Attack', hourAgo, 1_500_000],
      ['Overall', hourAgo, 1_500_000],
    ]);
    await seed.event(main.id, { type: 'loot', valueGp: 38_200_000 });
    const secret = await seed.account({ owner: bob, name: 'Hermit' });
    for (const category of ['stats', 'events', 'activity'] as const) {
      await seed.sharing(secret.id, category, 'private');
    }
    await seed.event(secret.id, { type: 'death' });

    await signIn({ name: 'Viewer' });
    const html = await render();
    expect(html).toContain('>Alice<');
    expect(html).toContain('>Zezima<');
    expect(html).not.toContain('Hermit');
    expect(html).not.toContain('>Bob<');
    expect(html).toContain('received');
    expect(html).toContain('1 member with accounts you can see.');
    // Today's Overall board (the tab and skill shown first).
    expect(html).toContain('+500,000 XP');
  });
});

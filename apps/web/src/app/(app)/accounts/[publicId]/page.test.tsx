/**
 * The account page as a Server Component render sees it (next/headers stubbed with the request's
 * cookie, next/navigation's client hooks stubbed): who gets through, notFound() for invisible
 * accounts, and each section's three states (hidden / "Not shared" / data) for the owner and for a
 * guild member who is kept out of some categories (handoff §10).
 */
import { CATEGORIES } from '@hub/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToReadableStream } from 'react-dom/server';
import {
  accountSeeder,
  skillMap,
  type AccountSeeder,
  type SeededAccount,
} from '@/app/api/app/accounts/test-seed';
import { TooltipProvider } from '@/components/ui/tooltip';
import { withTestDb, type WebTestContext } from '@/lib/test-utils';
import AccountPageRoute from './page';

const page = vi.hoisted(() => ({ headers: new Headers() }));

vi.mock('next/headers', () => ({
  headers: () => Promise.resolve(page.headers),
  cookies: () =>
    Promise.resolve({ get: () => undefined, getAll: () => [], has: () => false, set: () => {} }),
}));

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useRouter: () => ({ refresh() {}, push() {}, replace() {}, back() {}, prefetch() {} }),
  usePathname: () => '/accounts/x',
}));

let ctx: WebTestContext;
let seed: AccountSeeder;

beforeAll(async () => {
  ctx = await withTestDb({ label: 'accountpage' });
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

/** The page's HTML, "redirect:<path>" or "not-found". */
async function render(publicId: string): Promise<string> {
  try {
    const element = await AccountPageRoute({
      params: Promise.resolve({ publicId }),
      searchParams: Promise.resolve({}),
    });
    // An error inside a Suspense boundary (a section's loader) would only show its skeleton; fail
    // on it instead. next/dynamic's client-only bailout (the lazy charts) is expected.
    const errors: unknown[] = [];
    const stream = await renderToReadableStream(<TooltipProvider>{element}</TooltipProvider>, {
      onError: (err) => {
        const digest = (err as { digest?: unknown }).digest;
        if (digest !== 'BAILOUT_TO_CLIENT_SIDE_RENDERING') errors.push(err);
      },
    });
    await stream.allReady;
    if (errors.length > 0) throw errors[0];
    // Text-node separators React adds between adjacent strings ("World<!-- -->302").
    return (await new Response(stream).text()).replace(/<!-- -->/g, '');
  } catch (err) {
    const digest = (err as { digest?: unknown }).digest;
    if (typeof digest === 'string' && digest.startsWith('NEXT_REDIRECT')) {
      return `redirect:${digest.split(';')[2]}`;
    }
    if (typeof digest === 'string' && digest.startsWith('NEXT_HTTP_ERROR_FALLBACK;404')) {
      return 'not-found';
    }
    throw err;
  }
}

/** Section headings (h2) present in the HTML. */
function headings(html: string): string[] {
  return [...html.matchAll(/<h2[^>]*>([^<]+)<\/h2>/g)].map((m) => m[1] ?? '');
}

describe('account page', () => {
  let ownerId: string;
  let account: SeededAccount;
  let bare: SeededAccount;

  beforeAll(async () => {
    ownerId = await ctx.seedUser({ name: 'Owner Person' });
    account = await seed.account({ owner: ownerId, name: 'Zezima', accountType: 1 });
    const now = new Date();
    await seed.latestState(account.id, {
      lastSeen: new Date(now.getTime() - 1_000),
      gameState: 'LOGGED_IN',
      tickDelay: 0,
      world: 302,
      skills: skillMap({ Attack: [13_034_431, 99], Strength: [40_000_000, 105], Magic: [83, 2] }),
      skillsUpdatedAt: now,
      hpCurrent: 115,
      hpMax: 99,
      healthUpdatedAt: now,
      prayerCurrent: 40,
      prayerMax: 99,
      prayerUpdatedAt: now,
      spellbook: 'lunar',
      spellbookUpdatedAt: now,
      location: { x: 3222, y: 3218, plane: 0, isOnBoat: true },
      locationUpdatedAt: now,
      inventory: [
        { id: 385, name: 'Shark', gePrice: 900, quantity: 1 },
        { id: 385, name: 'Shark', gePrice: 900, quantity: 1 },
        { id: 995, name: 'Coins', gePrice: 1, quantity: 150_000 },
      ],
      inventoryUpdatedAt: now,
      equipment: [
        {
          id: 4151,
          name: 'Abyssal whip',
          gePrice: 1_500_000,
          quantity: 1,
          equipmentSlot: 'WEAPON',
        },
      ],
      equipmentUpdatedAt: now,
    });
    await seed.name(account.id, 'OldName', new Date(now.getTime() - 86_400_000));
    await seed.event(account.id, { type: 'loot', valueGp: 38_200_000 });
    await seed.session(account.id, {
      startedAt: new Date(now.getTime() - 3_600_000),
      lastSeenAt: now,
      worlds: [302],
    });
    // An account that never sent any section.
    bare = await seed.account({ owner: ownerId, name: 'Bare' });
    await seed.latestState(bare.id, { lastSeen: new Date(now.getTime() - 60 * 60_000) });
  });

  it('sends signed-out and grace users to /login', async () => {
    expect(await render(account.publicId)).toBe('redirect:/login');
    await signIn({ status: 'grace' });
    expect(await render(account.publicId)).toBe('redirect:/login');
  });

  it('answers not found for an unknown account and for one nothing is shared of', async () => {
    await signIn();
    expect(await render('NoSuchAcct00')).toBe('not-found');
    const secret = await seed.account({ owner: ownerId });
    for (const category of CATEGORIES) {
      await seed.sharing(secret.id, category, 'private');
    }
    expect(await render(secret.publicId)).toBe('not-found');
  });

  it('answers not found (not an error page) for a public id that cannot exist', async () => {
    await signIn();
    // `/accounts/abc%00def`: Next hands the page the decoded NUL, which Postgres refuses (22021).
    expect(await render('abc\u0000def')).toBe('not-found');
  });

  it('shows only the day of an update to viewers without the activity category (D-50)', async () => {
    const quiet = await seed.account({ owner: ownerId, name: 'Quiet' });
    await seed.sharing(quiet.id, 'activity', 'private');
    const now = new Date();
    await seed.latestState(quiet.id, {
      lastSeen: now,
      skills: skillMap({ Attack: [83, 2] }),
      skillsUpdatedAt: now,
    });
    await signIn({ name: 'Onlooker' });
    const html = await render(quiet.publicId);
    expect(headings(html)).toContain('Skills');
    // The read model sends local midnight; "Updated 9 h ago" would state a time nobody knows.
    expect(html).toContain('Updated today');
    expect(html).not.toMatch(/Updated (just now|\d+ (min|h) ago)/);

    // The owner has activity: the exact time stays relative.
    page.headers = new Headers({ cookie: await ctx.signIn(ownerId) });
    const own = await render(quiet.publicId);
    expect(own).toMatch(/Updated (just now|\d+ (s|sec|min) ago)/);
    expect(own).not.toContain('Updated today');
  });

  it('shows the owner every section, the sharing panel and the header', async () => {
    page.headers = new Headers({ cookie: await ctx.signIn(ownerId) });
    const html = await render(account.publicId);
    expect(html).toMatch(/<h1[^>]*>Zezima<\/h1>/);
    expect(html).toContain('Ironman');
    expect(html).toContain('Your account');
    expect(html).toContain('OldName');
    expect(html).toContain('World 302');
    expect(headings(html)).toEqual([
      'Skills',
      'XP history',
      'Sessions &amp; playtime',
      'Events',
      'Vitals',
      'Location',
      'Equipment',
      'Inventory',
      'Wealth',
      'Sharing',
    ]);
    // Total level is the real one (D-44): 99 + 99 + 2; Strength's virtual 105 shown subtly.
    expect(html).toContain('>200<');
    expect(html).toContain('(105)');
    // Boosted HP is clamped visually and says so.
    expect(html).toContain('+16 boosted');
    expect(html).toContain('On a boat');
    expect(html).toContain('3222, 3218');
    expect(html).toContain('Abyssal whip');
    expect(html).toContain('2 ×');
    expect(html).toContain('Lunar');
    expect(html).toContain('received');
    // The streamed sections rendered their content, not only their skeletons.
    expect(html).toContain('Recent sessions');
    expect(html).toContain('In progress');
    expect(html).not.toContain('Not shared');
  });

  it('badges sections the plugin never sent instead of showing them empty', async () => {
    page.headers = new Headers({ cookie: await ctx.signIn(ownerId) });
    const html = await render(bare.publicId);
    expect(headings(html)).toEqual(
      expect.arrayContaining(['Skills', 'Vitals', 'Location', 'Equipment', 'Inventory', 'Events']),
    );
    expect(headings(html)).not.toContain('XP history');
    expect(headings(html)).not.toContain('Wealth');
    expect((html.match(/>Not shared</g) ?? []).length).toBeGreaterThanOrEqual(6);
  });

  it('hides what a guild member may not see, and never shows them the sharing panel', async () => {
    for (const category of ['location_history', 'equipment', 'inventory'] as const) {
      await seed.sharing(account.id, category, 'private');
    }
    await signIn({ name: 'Member' });
    const html = await render(account.publicId);
    expect(headings(html)).toEqual([
      'Skills',
      'XP history',
      'Sessions &amp; playtime',
      'Events',
      'Vitals',
      'Location',
    ]);
    // Live location stays shared with the guild (the default, D-96); the rest is private.
    expect(html).toContain('3222, 3218');
    for (const hidden of ['Abyssal whip', 'Shark', 'Sharing']) {
      expect(html).not.toContain(hidden);
    }
    expect(html).not.toContain('Your account');
  });

  it('gives a contributor the read-only sharing panel', async () => {
    const contributor = await signIn({ name: 'Second Player' });
    await seed.link(account.id, contributor);
    const html = await render(account.publicId);
    expect(headings(html)).toContain('Sharing');
    expect(html).toContain('Only the owner can change who sees what.');
    expect(html).toContain('You play this');
  });
});

/**
 * The collection log pages as a Server Component render sees them (D-118): a character's log (who
 * gets through, notFound() before anything streams, NEXT-14) and the guild's board with the lookup.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToReadableStream } from 'react-dom/server';
import { accountSeeder, type AccountSeeder } from '@/app/api/app/accounts/test-seed';
import { TooltipProvider } from '@/components/ui/tooltip';
import { withTestDb, type WebTestContext } from '@/lib/test-utils';
import GuildCollectionLogPage from '../../../guild/collection-log/page';
import CollectionLogPage from './page';

const page = vi.hoisted(() => ({ headers: new Headers() }));

vi.mock('next/headers', () => ({
  headers: () => Promise.resolve(page.headers),
  cookies: () =>
    Promise.resolve({ get: () => undefined, getAll: () => [], has: () => false, set: () => {} }),
}));

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useRouter: () => ({ refresh() {}, push() {}, replace() {}, back() {}, prefetch() {} }),
  usePathname: () => '/guild/collection-log',
}));

let ctx: WebTestContext;
let seed: AccountSeeder;

beforeAll(async () => {
  ctx = await withTestDb({ label: 'clogpage' });
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
async function render(element: Promise<React.ReactElement>): Promise<string> {
  try {
    const errors: unknown[] = [];
    const stream = await renderToReadableStream(
      <TooltipProvider>{await element}</TooltipProvider>,
      {
        onError: (err) => {
          const digest = (err as { digest?: unknown }).digest;
          if (digest !== 'BAILOUT_TO_CLIENT_SIDE_RENDERING') errors.push(err);
        },
      },
    );
    await stream.allReady;
    if (errors.length > 0) throw errors[0];
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

const log = (publicId: string) =>
  render(
    CollectionLogPage({ params: Promise.resolve({ publicId }), searchParams: Promise.resolve({}) }),
  );
const guild = (q?: string) =>
  render(
    GuildCollectionLogPage({
      params: Promise.resolve({}),
      searchParams: Promise.resolve(q === undefined ? {} : { q }),
    }),
  );

async function slot(accountId: number, item: string, killCount?: number) {
  await seed.event(accountId, {
    type: 'collection_log',
    itemId: 12922,
    data: {
      type: 'collectionLog',
      data: { itemName: item, itemId: 12922, killCount },
      eventId: item,
      timestamp: 0,
    },
  });
}

describe('collection log pages', () => {
  it('sends signed-out users to /login', async () => {
    expect(await guild()).toBe('redirect:/login');
  });

  it('shows a character’s slots, and a 404 when neither events nor hiscores are shared', async () => {
    const owner = await ctx.seedUser({ name: 'Owner' });
    const mira = await seed.account({ owner, name: 'Clog Mira' });
    await slot(mira.id, 'Tanzanite fang', 212);
    const hermit = await seed.account({ owner, name: 'Hermit' });
    await slot(hermit.id, 'Secret pet');
    // Stats stay shared: the account is visible, its log is not.
    for (const category of ['events', 'hiscores'] as const) {
      await seed.sharing(hermit.id, category, 'private');
    }

    await signIn();
    const html = await log(mira.publicId);
    expect(html).toMatch(/<h1[^>]*>Collection log<\/h1>/);
    expect(html).toContain('Tanzanite fang');
    expect(html).toContain('Without a drop');
    expect(html).toContain('212');
    expect(await log(hermit.publicId)).toBe('not-found');
    expect(await log('nope')).toBe('not-found');

    const board = await guild();
    expect(board).toContain('Clog Mira');
    expect(board).not.toContain('Hermit');
    const lookup = await guild('fang');
    expect(lookup).toContain('Who has “fang”');
    expect(lookup).toContain('Tanzanite fang');
    expect(await guild('secret')).toContain('Nobody has logged an item like that');
  });
});

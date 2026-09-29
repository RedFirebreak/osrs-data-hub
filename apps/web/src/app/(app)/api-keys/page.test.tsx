/**
 * The API keys page as a Server Component render sees it (next/headers stubbed with the request's
 * headers, next/navigation's client hooks stubbed, as in ../devices/page.test.tsx): who gets
 * through, that only the signed-in user's keys are listed and never a secret, the empty state, and
 * the listed accounts the owner can no longer see.
 */
import { CATEGORIES } from '@hub/core';
import { accountSharing } from '@hub/db';
import { createApiKey, revokeApiKey } from '@hub/server';
import { renderToReadableStream } from 'react-dom/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { accountSeeder } from '@/app/api/app/accounts/test-seed';
import { TooltipProvider } from '@/components/ui/tooltip';
import { withTestDb, type WebTestContext } from '@/lib/test-utils';
import ApiKeysPage from './page';

const page = vi.hoisted(() => ({ headers: new Headers() }));

vi.mock('next/headers', () => ({
  headers: () => Promise.resolve(page.headers),
  cookies: () =>
    Promise.resolve({ get: () => undefined, getAll: () => [], has: () => false, set: () => {} }),
}));

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useRouter: () => ({ refresh() {}, push() {}, replace() {}, back() {}, prefetch() {} }),
  usePathname: () => '/api-keys',
}));

let ctx: WebTestContext;

beforeAll(async () => {
  ctx = await withTestDb({ label: 'apikeyspage' });
});
beforeEach(() => {
  page.headers = new Headers();
});
afterAll(() => ctx.cleanup());

async function signIn(): Promise<string> {
  const userId = await ctx.seedUser();
  page.headers = new Headers({ cookie: await ctx.signIn(userId) });
  return userId;
}

/** The page's HTML, or "redirect:<path>". */
async function render(): Promise<string> {
  try {
    const element = await ApiKeysPage();
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

describe('API keys page', () => {
  it('sends signed-out visitors to /login', async () => {
    expect(await render()).toBe('redirect:/login');
  });

  it('shows the empty state with a call to action and the API reference link', async () => {
    await signIn();
    const html = await render();
    expect(html).toContain('No API keys yet');
    expect(html).toContain('Create key');
    expect(html).toContain('href="/docs/api"');
    expect(html).toContain('Home Assistant');
  });

  it('lists only the user’s keys, masked, never with their secret', async () => {
    const userId = await signIn();
    const otherId = await ctx.seedUser();
    const seed = accountSeeder(ctx.t.db);
    const mine = await seed.account({ owner: userId, name: 'Mine Main' });
    const theirs = await seed.account({ owner: otherId, name: 'Their Alt' });

    const listed = await createApiKey(ctx.t.db, userId, {
      name: 'Discord bot',
      categories: ['events', 'stats'],
      accountScope: 'list',
      accountPublicIds: [mine.publicId, theirs.publicId],
      expiresInDays: 30,
    });
    const revoked = await createApiKey(ctx.t.db, userId, {
      name: 'Old map',
      categories: ['location_live'],
      accountScope: 'all_visible',
    });
    await revokeApiKey(ctx.t.db, { userId, keyId: revoked.info.id });
    const foreign = await createApiKey(ctx.t.db, otherId, {
      name: 'Someone else’s key',
      categories: [...CATEGORIES],
      accountScope: 'all_visible',
    });
    // The other user's account stops being visible to this user: its name is withheld.
    await ctx.t.db.insert(accountSharing).values(
      CATEGORIES.map((category) => ({
        accountId: theirs.id,
        category,
        audience: 'private' as const,
      })),
    );

    const html = await render();
    expect(html).toContain('Discord bot');
    expect(html).toContain(`ohub_${listed.info.prefix}_…`);
    expect(html).not.toContain(listed.key.slice(16));
    expect(html).not.toContain(revoked.key.slice(16));
    expect(html).toContain('Active keys');
    expect(html).toContain('Revoked and expired keys');
    expect(html).toContain('Old map');
    expect(html).toContain('Mine Main');
    expect(html).toContain('An account you can no longer see');
    expect(html).not.toContain('Their Alt');
    expect(html).not.toContain('Someone else');
    expect(html).not.toContain(foreign.info.prefix);
    expect(html).toContain('in 30 days');
    expect(html).toContain('Events');
    expect(html).toContain('Live location');
  });
});

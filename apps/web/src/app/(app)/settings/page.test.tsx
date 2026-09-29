/**
 * The Settings page's data cards (D-78, D-79) as a Server Component render sees them: the download
 * link and the deletion date in the user's time zone. (The rest of the page: (app)/pages.test.tsx.)
 */
import { userSettings } from '@hub/db';
import { SELF_DELETE_UNDO_DAYS } from '@hub/server';
import { renderToReadableStream } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { withTestDb, type WebTestContext } from '@/lib/test-utils';
import SettingsPage from './page';

const page = vi.hoisted(() => ({ headers: new Headers() }));

vi.mock('next/headers', () => ({
  headers: () => Promise.resolve(page.headers),
  cookies: () =>
    Promise.resolve({ get: () => undefined, getAll: () => [], has: () => false, set: () => {} }),
}));

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useRouter: () => ({ refresh() {}, push() {}, replace() {}, back() {}, prefetch() {} }),
  usePathname: () => '/settings',
}));

let ctx: WebTestContext;

beforeAll(async () => {
  ctx = await withTestDb({ label: 'settingspage' });
});
afterAll(() => ctx.cleanup());

async function render(): Promise<string> {
  const element = await SettingsPage();
  const stream = await renderToReadableStream(<TooltipProvider>{element}</TooltipProvider>);
  await stream.allReady;
  // Without React's text separators, so sentences can be matched whole.
  return (await new Response(stream).text()).replace(/<!-- -->/g, '');
}

describe('settings page: your data', () => {
  it('offers the download as a plain same-origin link', async () => {
    const userId = await ctx.seedUser();
    page.headers = new Headers({ cookie: await ctx.signIn(userId) });
    const html = await render();
    expect(html).toMatch(/<h2[^>]*>Download my data<\/h2>/);
    expect(html).toMatch(/<a href="\/api\/app\/export" download=""[^>]*>/);
    expect(html).not.toContain('Coming soon');
  });

  it("says when a deletion started now would delete everything, in the user's time zone", async () => {
    const userId = await ctx.seedUser();
    await ctx.t.db.insert(userSettings).values({ userId, timezone: 'Pacific/Auckland' });
    page.headers = new Headers({ cookie: await ctx.signIn(userId) });
    const before = Date.now();
    const html = await render();
    const labels = [before, Date.now()].map((t) =>
      new Intl.DateTimeFormat('en-GB', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        timeZone: 'Pacific/Auckland',
      }).format(new Date(t + SELF_DELETE_UNDO_DAYS * 86_400_000)),
    );
    expect(html).toMatch(/<h2[^>]*>Delete my data<\/h2>/);
    expect(labels.some((label) => html.includes(`>${label}</time>`))).toBe(true);
    expect(html).toContain(`${SELF_DELETE_UNDO_DAYS} days to change your mind`);
    expect(html).toMatch(/Signing in again before then cancels it/);
  });
});

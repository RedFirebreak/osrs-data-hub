/**
 * The login page as a Server Component render sees it (next/headers stubbed with the request's
 * headers, like lib/session-pages.test.ts): who gets redirected, who sees the button, and the
 * markup (one h1, the mapped error text).
 */
import { getConfig, setConfigForTests } from '@hub/core';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { withTestDb, type WebTestContext } from '@/lib/test-utils';
import LoginPage, { generateMetadata } from './page';

const page = vi.hoisted(() => ({ headers: new Headers() }));

vi.mock('next/headers', () => ({
  headers: () => Promise.resolve(page.headers),
  cookies: () =>
    Promise.resolve({ get: () => undefined, getAll: () => [], has: () => false, set: () => {} }),
}));

let ctx: WebTestContext;

beforeAll(async () => {
  ctx = await withTestDb({ label: 'loginpage', env: { DISCORD_GUILD_NAME: 'Iron Lads' } });
});
beforeEach(() => {
  page.headers = new Headers();
});
afterAll(() => ctx.cleanup());

function props(searchParams: Record<string, string | string[] | undefined> = {}) {
  return { params: Promise.resolve({}), searchParams: Promise.resolve(searchParams) };
}

/** The rendered HTML, or "redirect:<path>" when the page redirected. */
async function render(
  searchParams: Record<string, string | string[] | undefined> = {},
): Promise<string> {
  try {
    const element = await LoginPage(props(searchParams) as PageProps<'/login'>);
    return renderToStaticMarkup(<TooltipProvider>{element}</TooltipProvider>);
  } catch (err) {
    const digest = (err as { digest?: unknown }).digest;
    if (typeof digest === 'string' && digest.startsWith('NEXT_REDIRECT')) {
      return `redirect:${digest.split(';')[2]}`;
    }
    throw err;
  }
}

/** Text only, so assertions don't depend on markup between words. */
function textOf(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ');
}

async function signIn(opts: Parameters<WebTestContext['seedUser']>[0] = {}): Promise<void> {
  const userId = await ctx.seedUser(opts);
  page.headers = new Headers({ cookie: await ctx.signIn(userId) });
}

describe('login page', () => {
  it('shows the hub name as the page heading and one sign-in button when signed out', async () => {
    const html = await render();
    expect(html).toMatch(/<h1[^>]*>Test Hub<\/h1>/);
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toContain('Sign in with Discord');
    expect(html).not.toContain('role="alert"');
  });

  it('says who the page is for, where the sign-in happens and that no game login is asked', async () => {
    const text = textOf(await render());
    expect(text).toContain('For members of Iron Lads only.');
    expect(text).toContain("If you're not in that server, you can't sign in here.");
    expect(text).toContain('You sign in at discord.com.');
    expect(text).toContain('never your email or messages');
    expect(text).toContain('The hub never asks for your RuneScape or Jagex login.');
    expect(text).toContain('HA Exporter plugin in RuneLite');
  });

  it('names the stand-in instead of discord.com when local development uses one (D-101)', async () => {
    const config = getConfig();
    setConfigForTests({
      ...config,
      discord: { ...config.discord, authorizeUrl: 'http://localhost:4010/oauth2/authorize' },
    });
    try {
      expect(textOf(await render())).toContain('You sign in at localhost:4010.');
    } finally {
      setConfigForTests(config);
    }
  });

  it('describes itself to search engines and link previews the same way', () => {
    const { title, description } = generateMetadata();
    expect(title).toBe('Sign in · Test Hub');
    expect(description).toContain('members of Iron Lads');
    expect(description).toContain('Discord');
    expect(description).toContain('never asks for a RuneScape or Jagex login');
  });

  it('sends an active user to the dashboard', async () => {
    await signIn();
    expect(await render()).toBe('redirect:/');
    expect(await render({ error: 'not_guild_member' })).toBe('redirect:/');
  });

  it('treats a user in grace as signed out (no redirect loop with requireUser)', async () => {
    await signIn({ status: 'grace' });
    expect(await render()).toContain('Sign in with Discord');
  });

  it('explains a refused sign-in and never echoes raw text', async () => {
    const html = await render({ error: 'MISSING_ROLE' });
    expect(html).toContain('role="alert"');
    expect(html).toContain('have a role that gives access');
    const odd = await render({ error: '<script>x</script>', error_description: 'evil' });
    expect(odd).toContain('Sign-in failed (unknown_error)');
    expect(odd).not.toContain('&lt;script');
    expect(odd).not.toContain('<script');
    expect(odd).not.toContain('evil');
  });

  it('says when the data goes after "Delete my data", and that signing in cancels it (D-78)', async () => {
    const html = await render({ deleted: '2026-10-06T14:05:09.123Z' });
    expect(html).toContain('Deletion scheduled');
    expect(html).toContain(
      'Your data will be deleted on <time dateTime="2026-10-06T14:05:09.123Z">6 October 2026, 14:05 UTC</time>.',
    );
    expect(html).toContain('Sign in again before then to cancel.');
    expect(html).toContain('Sign in with Discord');
    // An informational notice, not an error.
    expect(html).toContain('role="status"');
    expect(html).not.toContain('role="alert"');
  });

  it('shows the notice without a date it cannot parse, and never the raw parameter', async () => {
    const odd = await render({ deleted: '<img src=x onerror=alert(1)>' });
    expect(odd).toContain('Your data is scheduled for deletion.');
    expect(odd).not.toContain('<img');
    expect(odd).not.toContain('&lt;img');
    expect(odd).not.toContain('onerror');
    const rolled = await render({ deleted: '2026-02-30' });
    expect(rolled).toContain('Your data is scheduled for deletion.');
    expect(rolled).not.toContain('2026-02-30');
    expect(rolled).not.toContain('March');
  });
});

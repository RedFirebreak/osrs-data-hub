/**
 * The pairing wizard's page as a Server Component render sees it (next/headers and next/navigation
 * stubbed as in ../pages.test.tsx): who gets through, and the first step's markup (the wizard is a
 * client component; its rules are unit-tested in components/onboarding/wizard-model.test.ts).
 */
import { renderToReadableStream } from 'react-dom/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { withTestDb, type WebTestContext } from '@/lib/test-utils';
import OnboardingPage from './page';

const page = vi.hoisted(() => ({ headers: new Headers() }));

vi.mock('next/headers', () => ({
  headers: () => Promise.resolve(page.headers),
  cookies: () =>
    Promise.resolve({ get: () => undefined, getAll: () => [], has: () => false, set: () => {} }),
}));

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useRouter: () => ({ refresh() {}, push() {}, replace() {}, back() {}, prefetch() {} }),
  usePathname: () => '/onboarding',
}));

let ctx: WebTestContext;

beforeAll(async () => {
  ctx = await withTestDb({ label: 'onboardingpage' });
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

/** The page's props for `/onboarding` + `query`. */
function props(query: Record<string, string | string[]> = {}): PageProps<'/onboarding'> {
  return { params: Promise.resolve({}), searchParams: Promise.resolve(query) };
}

describe('onboarding page', () => {
  it('sends signed-out users to /login', async () => {
    expect(await render(() => OnboardingPage(props()))).toBe('redirect:/login');
  });

  it('starts at the install step with the minimum plugin version', async () => {
    await signIn();
    const html = await render(() => OnboardingPage(props()));
    expect(html).toMatch(/<h1[^>]*>Add a device<\/h1>/);
    expect(html).toContain('Install HA Exporter (1.5 or newer) from the RuneLite Plugin Hub.');
    expect(html).toContain('aria-current="step"');
    expect(html).toContain('placeholder="e.g. Desktop PC"');
    expect(html).toContain('Next: get a pairing code');
  });

  it('with ?code=<id> (a reload mid-pairing) renders step 2 loading that code, not step 1', async () => {
    await signIn();
    const html = await render(() =>
      OnboardingPage(props({ code: '0b7e1c9a-4a55-4f6e-9a55-3a1f7b2c9d10' })),
    );
    expect(html).toContain('Pair RuneLite with the hub');
    expect(html).toContain('Loading your code');
    expect(html).not.toContain('Next: get a pairing code');
    // Anything else in ?code= is ignored: a fresh wizard.
    const plain = await render(() => OnboardingPage(props({ code: '12345' })));
    expect(plain).toContain('Next: get a pairing code');
  });
});

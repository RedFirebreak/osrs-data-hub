/**
 * The Metrics tab and the boss page as a Server Component render sees them (D-106, D-108): who gets
 * through, notFound() before anything streams (NEXT-14), the panels the owner sees, and what a guild
 * member kept out of `activity` and `hiscores` sees instead.
 */
import { activityScores, accountHiscores } from '@hub/db';
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
import BossPage from './bosses/[activity]/page';
import MetricsPage from './page';

const page = vi.hoisted(() => ({ headers: new Headers() }));

vi.mock('next/headers', () => ({
  headers: () => Promise.resolve(page.headers),
  cookies: () =>
    Promise.resolve({ get: () => undefined, getAll: () => [], has: () => false, set: () => {} }),
}));

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useRouter: () => ({ refresh() {}, push() {}, replace() {}, back() {}, prefetch() {} }),
  usePathname: () => '/accounts/x/metrics',
}));

let ctx: WebTestContext;
let seed: AccountSeeder;

beforeAll(async () => {
  ctx = await withTestDb({ label: 'metricspage' });
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

async function useUser(userId: string): Promise<void> {
  page.headers = new Headers({ cookie: await ctx.signIn(userId) });
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

const metrics = (publicId: string, search: Record<string, string> = {}) =>
  render(
    MetricsPage({ params: Promise.resolve({ publicId }), searchParams: Promise.resolve(search) }),
  );
const boss = (publicId: string, activity: string) =>
  render(
    BossPage({
      params: Promise.resolve({ publicId, activity }),
      searchParams: Promise.resolve({}),
    }),
  );

function headings(html: string): string[] {
  return [...html.matchAll(/<h2[^>]*>([^<]+)<\/h2>/g)].map((m) => m[1] ?? '');
}

describe('Metrics pages', () => {
  let ownerId: string;
  let memberId: string;
  let account: SeededAccount;

  beforeAll(async () => {
    ownerId = await ctx.seedUser({ name: 'Metric Owner' });
    memberId = await ctx.seedUser({ name: 'Guild Member' });
    account = await seed.account({ owner: ownerId, name: 'Graph Fan' });
    const now = Date.now();
    const at = (hoursAgo: number) =>
      new Date(Math.floor((now - hoursAgo * 3_600_000) / 300_000) * 300_000);
    await seed.latestState(account.id, {
      lastSeen: at(20),
      skills: skillMap({ Ranged: [1_030_000, 73] }),
      skillsUpdatedAt: at(20),
    });
    await seed.session(account.id, { startedAt: at(24), endedAt: at(23), endReason: 'logout' });
    await seed.xp(account.id, [
      ['Ranged', at(30), 1_000_000],
      ['Overall', at(30), 1_000_000],
      ['Ranged', at(23.9), 1_030_000],
      ['Overall', at(23.9), 1_030_000],
    ]);
    await seed.event(account.id, {
      type: 'loot',
      occurredAt: at(23.5),
      valueGp: 2_000_000,
      data: { type: 'loot', data: { source: { text: 'Zulrah' } }, eventId: 'z', timestamp: 0 },
    });
    await ctx.t.db.insert(activityScores).values([
      { accountId: account.id, activity: 'Zulrah', readAt: at(40), score: 100, baseline: true },
      { accountId: account.id, activity: 'Zulrah', readAt: at(22.8), score: 112, baseline: false },
    ]);
    await ctx.t.db.insert(accountHiscores).values({
      accountId: account.id,
      lookupName: 'Graph Fan',
      mode: 'regular',
      status: 'ok',
      lastAttemptAt: at(22.8),
      fetchedAt: at(22.8),
      main: { skills: [], activities: [{ name: 'Zulrah', rank: 900, score: 112 }] },
    });
    // The guild member sees stats and events, not activity or hiscores.
    await seed.sharing(account.id, 'activity', 'private');
    await seed.sharing(account.id, 'hiscores', 'private');
  });

  it('sends signed-out users to /login and answers not found for unknown accounts', async () => {
    expect(await metrics(account.publicId)).toBe('redirect:/login');
    await signIn();
    expect(await metrics('nope')).toBe('not-found');
    expect(await metrics('%00')).toBe('not-found');
  });

  it('shows the owner the totals, the charts, the sessions, the bosses and the goal form', async () => {
    await useUser(ownerId);
    const html = await metrics(account.publicId);
    expect(headings(html)).toEqual(
      expect.arrayContaining([
        'XP through the range',
        'When it hits',
        'Sessions by length and rate',
        'Rate through a session',
        'Where the time goes',
        'Sessions',
        'Skills',
        'Bosses',
        'Goals',
      ]),
    );
    expect(html).toContain('30,000');
    expect(html).toContain('Mostly Zulrah');
    expect(html).toContain('12 kills');
    expect(html).toContain('Set goal');
    expect(html).toContain('aria-current="page"');
  });

  it('opens a session timeline from the URL', async () => {
    await useUser(ownerId);
    const [{ id } = { id: '' }] = await ctx.t.db.query.playSessions.findMany({
      where: (s, { eq }) => eq(s.accountId, account.id),
    });
    const html = await metrics(account.publicId, { session: id });
    expect(headings(html).some((h) => h.startsWith('Session of'))).toBe(true);
  });

  it('leaves a member without activity and hiscores the stats and the loot only', async () => {
    await useUser(memberId);
    const html = await metrics(account.publicId);
    expect(html).toContain('doesn&#x27;t share its play sessions or stats with you');
    expect(headings(html)).not.toContain('Bosses');
    expect(headings(html)).toContain('Skills');
    expect(html).not.toContain('Set goal');
    expect(html).not.toContain('Mostly Zulrah');
  });

  it('shows a boss page to the owner and answers not found for others and non-bosses', async () => {
    await useUser(ownerId);
    const html = await boss(account.publicId, 'Zulrah');
    expect(html).toContain('<h1');
    expect(html).toContain('Zulrah');
    expect(html).toContain('rank 900');
    expect(html).toContain('2M gp');
    expect(await boss(account.publicId, 'Clue%20Scrolls%20(all)')).toBe('not-found');
    expect(await boss(account.publicId, '%E0%A4%A')).toBe('not-found');
    await useUser(memberId);
    expect(await boss(account.publicId, 'Zulrah')).toBe('not-found');
  });
});

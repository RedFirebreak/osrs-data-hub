/**
 * Progress, a skill's page, Deep dive and the boss page as a Server Component render sees them (D-106, D-108,
 * D-112): who gets through, notFound() before anything streams (NEXT-14), what the owner sees, and
 * what a guild member kept out of `activity` and `hiscores` sees instead.
 */
import { activityScores, accountHiscores, osrsAccounts } from '@hub/db';
import { eq } from 'drizzle-orm';
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
import DeepDivePage from './deep-dive/page';
import ProgressPage from './page';
import SkillPage from './skills/[skill]/page';

const page = vi.hoisted(() => ({ headers: new Headers() }));

vi.mock('next/headers', () => ({
  headers: () => Promise.resolve(page.headers),
  cookies: () =>
    Promise.resolve({ get: () => undefined, getAll: () => [], has: () => false, set: () => {} }),
}));

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useRouter: () => ({ refresh() {}, push() {}, replace() {}, back() {}, prefetch() {} }),
  usePathname: () => '/progress/x',
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

const progress = (publicId: string, search: Record<string, string> = {}) =>
  render(
    ProgressPage({ params: Promise.resolve({ publicId }), searchParams: Promise.resolve(search) }),
  );
const metrics = (publicId: string, search: Record<string, string> = {}) =>
  render(
    DeepDivePage({ params: Promise.resolve({ publicId }), searchParams: Promise.resolve(search) }),
  );
const skill = (publicId: string, name: string, search: Record<string, string> = {}) =>
  render(
    SkillPage({
      params: Promise.resolve({ publicId, skill: name }),
      searchParams: Promise.resolve(search),
    }),
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

/** The labels of the pressed buttons (the range, then the measure). */
function pressed(html: string): string[] {
  return [...html.matchAll(/<button[^>]*aria-pressed="true"[^>]*>([^<]+)<\/button>/g)].map(
    (m) => m[1] ?? '',
  );
}

describe('Progress pages', () => {
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
    // The hub saw the account before its first XP, as it does outside a test.
    await ctx.t.db
      .update(osrsAccounts)
      .set({ firstSeen: at(40) })
      .where(eq(osrsAccounts.id, account.id));
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
      type: 'level_up',
      occurredAt: at(23.9),
      skill: 'Ranged',
      level: 73,
      data: { type: 'level_up', data: {}, eventId: 'l', timestamp: 0 },
    });
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
    expect(await progress(account.publicId)).toBe('redirect:/login');
    expect(await metrics(account.publicId)).toBe('redirect:/login');
    await signIn();
    for (const page of [progress, metrics]) {
      expect(await page('nope')).toBe('not-found');
      expect(await page('%00')).toBe('not-found');
    }
  });

  it('answers the owner first: one amount, its range and what it counts', async () => {
    await useUser(ownerId);
    const html = await progress(account.publicId);
    expect(html).toContain('>Progress</h1>');
    expect(html).toContain('How Graph Fan is coming along.');
    // The amount for assistive tech, then the digits that count up to it.
    expect(html).toContain('<span class="sr-only">+30,000 XP</span>');
    expect(html).toContain('in the last 7 days');
    // The range control and the measure pills, 7D and XP pressed by default.
    for (const range of ['1D', '7D', '30D', '90D', '1Y']) {
      expect(html).toContain(`>${range}</button>`);
    }
    expect(pressed(html)).toEqual(['7D', 'XP']);
    expect(html).not.toContain('disabled=""');
  });

  it('lists what was trained, the bosses and the goals, and leads on to the detail', async () => {
    await useUser(ownerId);
    const html = await progress(account.publicId);
    expect(headings(html)).toEqual(expect.arrayContaining(['Skills trained', 'Bosses', 'Goals']));
    const base = `/progress/${account.publicId}`;
    // A skill opens its own page, a boss its page with the same range, Deep dive the same view.
    expect(html).toContain(`href="${base}/skills/ranged"`);
    expect(html).toContain(`href="${base}/bosses/Zulrah?range=7d"`);
    expect(html).toContain('112 kills in total');
    expect(html).toContain('>+12</span>');
    expect(html).toContain(`href="${base}/deep-dive?range=7d"`);
    expect(html).toContain('Set goal');
  });

  it('follows the range and the measure in the address', async () => {
    await useUser(ownerId);
    const loot = await progress(account.publicId, { range: '30d', measure: 'gp' });
    expect(loot).toContain('<span class="sr-only">+2M gp</span>');
    expect(loot).toContain('in the last 30 days, from 1 drop');
    expect(pressed(loot)).toEqual(['30D', 'Loot']);
    expect(loot).toContain('/deep-dive?measure=gp"');

    // "1D" is the last 24 hours: the session of 24 to 23 hours ago is in it.
    const day = await progress(account.publicId, { range: '1d' });
    expect(day).toContain('<span class="sr-only">+30,000 XP</span>');
    expect(day).toContain('in the last 24 hours');
    // Anything unknown is the default view, not an error.
    expect(pressed(await progress(account.publicId, { range: 'x', measure: 'y' }))).toEqual([
      '7D',
      'XP',
    ]);
  });

  it('offers a member only the measures shared with them', async () => {
    await useUser(memberId);
    const html = await progress(account.publicId);
    expect(html).toContain('a guild member&#x27;s character');
    expect(html).toContain('<span class="sr-only">+30,000 XP</span>');
    // Boss kills (hiscores) and play time (activity) are private here.
    expect((html.match(/disabled=""/g) ?? []).length).toBe(2);
    expect(headings(html)).not.toContain('Bosses');
    expect(html).not.toContain('Set goal');

    const kills = await progress(account.publicId, { measure: 'kills' });
    expect(kills).toContain('Not shared');
    expect(kills).not.toContain('+12');
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
    // One level under Progress, and it says so.
    expect(html).toContain('>Deep dive</h1>');
    expect(html).toContain(`href="/progress/${account.publicId}"`);
    // What left the character page: playtime per day with the recent sessions, and wealth.
    expect(headings(html)).toEqual(expect.arrayContaining(['Sessions &amp; playtime', 'Wealth']));
    expect(html).toContain('Recent sessions');
    // A session opens its timeline here, a boss its own page.
    expect(html).toContain(`href="/progress/${account.publicId}/deep-dive?session=`);
    expect(html).toContain(`href="/progress/${account.publicId}/bosses/Zulrah"`);
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
    expect(headings(html)).not.toContain('Sessions &amp; playtime');
    expect(headings(html)).toContain('Skills');
    expect(html).not.toContain('Set goal');
    expect(html).not.toContain('Mostly Zulrah');
  });

  it("shows a skill where it stands and how it grew, in the skill's name", async () => {
    await useUser(ownerId);
    const html = await skill(account.publicId, 'ranged');
    expect(html).toContain('>Ranged</h1>');
    expect(html).toContain('1,030,000 XP');
    // Level 73 starts at 992,895 XP and 74 at 1,096,278.
    expect(html).toMatch(/\d+% of the way to 74/);
    expect(html).toContain('66,278 XP to go');
    expect(html).toContain('<span class="sr-only">+30,000 XP</span>');
    expect(html).toContain('in the last 7 days');
    // Every range, and all of the history; no measure to pick.
    for (const range of ['1D', '7D', '30D', '90D', '1Y', 'All']) {
      expect(html).toContain(`>${range}</button>`);
    }
    expect(pressed(html)).toEqual(['7D']);
    // The pace, the level-up of the range, the way to set a goal, and the way back.
    expect(html).toContain('XP an hour while training');
    expect(html).toContain('Reached level');
    expect(headings(html)).toEqual(expect.arrayContaining(['Milestones', 'Goal']));
    expect(html).toContain('Set goal');
    expect(html).toContain(`href="/progress/${account.publicId}"`);
    // The strip marks this skill among the character's skills.
    expect(html).toMatch(/aria-current="page"[^>]*aria-label="Ranged"/);
  });

  it('draws all of a skill from the first XP the hub saw', async () => {
    await useUser(ownerId);
    const html = await skill(account.publicId, 'ranged', { range: 'all' });
    expect(pressed(html)).toEqual(['All']);
    expect(html).toContain('<span class="sr-only">+30,000 XP</span>');
    expect(html).toContain('since the hub first saw this character');
    // Going back up, the summary gets its longest range.
    expect(html).toContain(`href="/progress/${account.publicId}?range=1y"`);
  });

  it('answers not found for what is not a skill, and for stats that are not shared', async () => {
    await useUser(ownerId);
    for (const name of ['overall', 'combat', 'dungeoneering', '%E0%A4%A']) {
      expect(await skill(account.publicId, name)).toBe('not-found');
    }
    // A skill the character never trained has no page either (inside the page: its skills are
    // only known once they are read).
    expect(await skill(account.publicId, 'magic')).toBe('not-found');
    expect(await skill('nope', 'ranged')).toBe('not-found');
    // The member reads stats, so the page opens, without what needs activity or events.
    await useUser(memberId);
    const html = await skill(account.publicId, 'Ranged');
    expect(html).toContain('>Ranged</h1>');
    expect(html).not.toContain('XP an hour while training');
    expect(html).not.toContain('Set goal');
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

  // Last: it makes the account's stats private for the member.
  it('answers not found for a skill whose stats are not shared', async () => {
    await seed.sharing(account.id, 'stats', 'private');
    await useUser(memberId);
    expect(await skill(account.publicId, 'ranged')).toBe('not-found');
    await useUser(ownerId);
    expect(await skill(account.publicId, 'ranged')).toContain('>Ranged</h1>');
  });
});

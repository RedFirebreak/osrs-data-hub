/**
 * Visual QA: screenshots of every page, at desktop (1440×900) and phone (390×844) width, in light and
 * dark, with realistic data. Not a test of behaviour, and not part of `pnpm test:e2e`: tagged
 * @screenshots, which playwright.config.ts leaves out unless E2E_SCREENSHOTS=1. Run from the repo root:
 *
 *   E2E_SCREENSHOTS=1 PW_CHROMIUM_PATH=/opt/pw-browsers/chromium pnpm test:e2e
 *
 * The PNGs land in apps/web/e2e/screenshots/ (gitignored), named `<nn>-<page>-<viewport>-<scheme>.png`
 * in the order they were taken. Look at them after a UI change.
 *
 * The data goes in the way real data does: devices are paired (alice through the wizard, carol and a
 * second device of alice's through the API) and the payload fixtures (packages/fixtures/payloads) are
 * POSTed to /api/osrs-data/events as the plugin would. alice (admin) owns Zezima and Lynx Titan (whose
 * plugin doesn't send inventory, equipment or location, so those sections say "Not shared"); carol owns
 * Iron Mira. carol looking at Zezima is the guild-member view (everything is shared by default, D-96).
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import {
  expect,
  test,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import { HUB_URL } from './env';
import {
  FakePlugin,
  newClientIp,
  payloadFixture,
  signInWithDiscord,
  type DiscordHandle,
} from './support';

const OUT_DIR = path.join(import.meta.dirname, 'screenshots');

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'phone', width: 390, height: 844 },
] as const;
const SCHEMES = ['light', 'dark'] as const;

const MINUTE = 60_000;

let shotNo = 0;

interface ShootOptions {
  /** Whole page (default) or only the viewport (for things pinned to the viewport, like toasts). */
  fullPage?: boolean;
  /** Extra settle time, for charts (ECharts animates its first render). */
  waitMs?: number;
  /** Only these viewports (default: both). */
  viewports?: readonly (typeof VIEWPORTS)[number]['name'][];
  /** Runs before each shot, after the viewport and scheme are set (open a menu, send a toast…). */
  before?: (page: Page) => Promise<void>;
}

/** Waits until the page has no skeletons left, its fonts are in, and layout has settled. */
async function settle(page: Page, waitMs = 0): Promise<void> {
  await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0, { timeout: 15_000 });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  await page.waitForTimeout(250 + waitMs);
}

/** Screenshots the current page in every viewport and colour scheme. */
async function shoot(page: Page, name: string, options: ShootOptions = {}): Promise<void> {
  const n = String(++shotNo).padStart(2, '0');
  for (const viewport of VIEWPORTS) {
    if (options.viewports && !options.viewports.includes(viewport.name)) continue;
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    for (const scheme of SCHEMES) {
      await page.emulateMedia({ colorScheme: scheme });
      // No hover effects from the last click.
      await page.mouse.move(0, 0);
      await options.before?.(page);
      await settle(page, options.waitMs);
      await page.screenshot({
        path: path.join(OUT_DIR, `${n}-${name}-${viewport.name}-${scheme}.png`),
        fullPage: options.fullPage ?? true,
        animations: 'disabled',
      });
      // Close whatever `before` opened, so the next round can open it again.
      if (options.before) await page.keyboard.press('Escape');
    }
  }
  await page.setViewportSize({ width: VIEWPORTS[0].width, height: VIEWPORTS[0].height });
  await page.emulateMedia({ colorScheme: 'light' });
}

async function visit(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await expect(page.locator('main')).toBeVisible();
}

interface Member {
  handle: DiscordHandle;
  context: BrowserContext;
  page: Page;
  plugin: FakePlugin;
}

/** A browser of its own, signed in as `handle`, and that person's RuneLite (the plugin). */
async function signIn(
  browser: Browser,
  request: APIRequestContext,
  handle: DiscordHandle,
): Promise<Member> {
  const ip = newClientIp();
  const context = await browser.newContext({
    viewport: { width: VIEWPORTS[0].width, height: VIEWPORTS[0].height },
    extraHTTPHeaders: { 'x-forwarded-for': ip },
  });
  const page = await context.newPage();
  await signInWithDiscord(page, handle);
  await expect(page).toHaveURL(`${HUB_URL}/`);
  return { handle, context, page, plugin: new FakePlugin(request, ip) };
}

/** Pairs a device through the API, as the wizard does; returns the plugin's token. */
async function pairDevice(member: Member, label: string): Promise<string> {
  const created = await member.page.request.post('/api/app/pairing-codes', {
    headers: { origin: HUB_URL },
    data: { label },
  });
  expect(created.status()).toBe(201);
  const { code } = (await created.json()) as { code: string };
  const paired = await member.plugin.pair(code, '1.5');
  expect(paired.status()).toBe(200);
  return ((await paired.json()) as { token: string }).token;
}

/**
 * A fixture as sent at `sentAt`, with its events at `eventsAt` (default: when sent) and fresh event
 * ids. The snapshot's time decides which state is the latest, the events' times where they show up
 * in the timelines. The hub moves event times older than 15 minutes before receipt up to that
 * (clampEventTime, @hub/core), so a history can't be backdated further.
 */
function payload(
  name: string,
  sentAt: number,
  eventsAt = sentAt,
  edit?: (body: Record<string, unknown>) => void,
): Record<string, unknown> {
  const body = payloadFixture(name);
  body.timestamp = sentAt;
  if (Array.isArray(body.events)) {
    const events = body.events as Record<string, unknown>[];
    body.events = events.map((event, i) => ({
      ...event,
      eventId: randomUUID(),
      timestamp: eventsAt - (events.length - 1 - i) * 20_000,
    }));
  }
  edit?.(body);
  return body;
}

async function send(member: Member, token: string, body: unknown): Promise<void> {
  const res = await member.plugin.send(token, body);
  expect(res.status(), await res.text()).toBe(200);
}

/** The /accounts/<publicId> path of the dashboard card for `name`. */
async function accountHref(page: Page, name: string): Promise<string> {
  await visit(page, '/');
  const link = page
    .getByRole('region', { name: 'Your accounts' })
    .getByRole('link', { name, exact: true })
    .first();
  const href = await link.getAttribute('href');
  expect(href).toMatch(/^\/accounts\/[^/]+$/);
  return href as string;
}

test('screenshots of every page', { tag: '@screenshots' }, async ({ browser, request }) => {
  test.setTimeout(15 * 60_000);
  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });

  await test.step('login', async () => {
    const context = await browser.newContext({
      extraHTTPHeaders: { 'x-forwarded-for': newClientIp() },
    });
    const page = await context.newPage();
    await visit(page, '/login');
    await shoot(page, 'login');
    await visit(page, '/login?error=not_guild_member');
    await shoot(page, 'login-not-member');
    await visit(page, '/login?deleted=2026-10-06T12:00:00.000Z');
    await shoot(page, 'login-deleted');
    await visit(page, '/privacy');
    await shoot(page, 'privacy-signed-out');
    await context.close();
  });

  // carol: a fresh member (empty dashboard), then the owner of Iron Mira.
  const carol = await signIn(browser, request, 'carol');
  await test.step('empty dashboard', async () => {
    await shoot(carol.page, 'dashboard-empty');
  });
  const carolToken = await pairDevice(carol, 'Carol’s desktop');
  // In the fixtures' own order (XP only goes up; a drop would make a snapshot count as special, D-24).
  // Older than alice's events below, so the guild feed (newest received first) reads in time order.
  const now = Date.now();
  await send(carol, carolToken, payload('event-death-dangerous', now, now - 14 * MINUTE));
  await send(carol, carolToken, payload('event-levelup-multi', now + 1, now - 13 * MINUTE));
  await send(carol, carolToken, payload('event-diary-repeat', now + 2, now - 12 * MINUTE));
  await send(carol, carolToken, payload('event-collectionlog', now + 3, now - 11 * MINUTE));
  await send(
    carol,
    carolToken,
    payload('event-collectionlog-unresolved', now + 4, now - 10 * MINUTE),
  );

  // alice (admin): the wizard, step by step.
  const alice = await signIn(browser, request, 'alice');
  let aliceToken = '';
  await test.step('wizard', async () => {
    const { page, plugin } = alice;
    await visit(page, '/onboarding');
    await expect(page.getByRole('heading', { name: 'Install HA Exporter' })).toBeVisible();
    await shoot(page, 'onboarding-1-install');

    await page.getByLabel('Name this device (optional)').fill('Gaming PC');
    await page.getByRole('button', { name: 'Next: get a pairing code' }).click();
    const codeBox = page.getByTestId('pairing-code');
    await expect(codeBox).toHaveAttribute('data-code', /^[0-9]{5}$/);
    await shoot(page, 'onboarding-2-pair');

    const code = (await codeBox.getAttribute('data-code')) ?? '';
    expect((await plugin.pair(code, '1.4')).status()).toBe(400);
    await expect(page.getByRole('alert').filter({ hasText: 'Update HA Exporter' })).toBeVisible();
    await shoot(page, 'onboarding-2-pair-outdated');

    const paired = await plugin.pair(code, '1.5');
    expect(paired.status()).toBe(200);
    aliceToken = ((await paired.json()) as { token: string }).token;
    await expect(page.getByText('Waiting for the first data from this device…')).toBeVisible();
    await shoot(page, 'onboarding-3-waiting');

    await send(alice, aliceToken, payload('snapshot-normal', Date.now()));
    await expect(page.getByText("You're the owner")).toBeVisible();
    await shoot(page, 'onboarding-3-first-data');

    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('heading', { name: "You're all set" })).toBeVisible();
    // The sharing controls load after the step shows (D-96).
    await expect(page.getByLabel('Inventory', { exact: true })).toBeVisible();
    await shoot(page, 'onboarding-4-done');
  });

  await test.step('seed alice’s accounts', async () => {
    // Events spread over the last 15 minutes (their toasts pop up on the wizard page, which is done);
    // the last snapshot is the current state.
    const t = Date.now();
    await send(alice, aliceToken, payload('event-death-safe', t + 1, t - 9 * MINUTE));
    await send(alice, aliceToken, payload('event-combattask', t + 2, t - 8 * MINUTE));
    await send(alice, aliceToken, payload('event-superior', t + 3, t - 7 * MINUTE));
    await send(alice, aliceToken, payload('event-unknown-type', t + 4, t - 6 * MINUTE));
    await send(alice, aliceToken, payload('event-loot', t + 5, t - 5 * MINUTE));
    await send(alice, aliceToken, payload('snapshot-world-hop', t + 6));
    // In combat at the Slayer Tower (XP a little up on the others).
    await send(alice, aliceToken, payload('snapshot-combat-burst-3', t + 7));
    // Lynx Titan on the same PC, with the plugin's inventory, equipment and location toggles off.
    await send(
      alice,
      aliceToken,
      payload('event-pkloot', t + 8, t - 3 * MINUTE, (body) => {
        const player = body.player as Record<string, unknown>;
        delete player.inventory;
        delete player.equipment;
        delete player.location;
      }),
    );
  });

  const zezima = await accountHref(alice.page, 'Zezima');
  const lynx = await accountHref(alice.page, 'Lynx Titan');

  await test.step('dashboard', async () => {
    await visit(alice.page, '/');
    await shoot(alice.page, 'dashboard', { waitMs: 300 });
    await shoot(alice.page, 'nav-menu', {
      viewports: ['phone'],
      fullPage: false,
      before: async (page) => {
        await page.getByRole('button', { name: 'Open navigation' }).click();
        await expect(page.getByRole('menu')).toBeVisible();
      },
    });
    await shoot(alice.page, 'user-menu', {
      fullPage: false,
      before: async (page) => {
        await page.getByRole('button', { name: 'Open the account menu' }).click();
        await expect(page.getByRole('menu')).toBeVisible();
      },
    });
  });

  await test.step('devices', async () => {
    const { page } = alice;
    // A second, old device of alice's, revoked: the "Revoked devices" list.
    const oldToken = await pairDevice(alice, 'Old laptop');
    await send(alice, oldToken, {
      events: [],
      state: 'LOGIN_SCREEN',
      tickDelay: 0,
      timestamp: Date.now(),
    });
    await visit(page, '/devices');
    const card = page
      .getByTestId('device-card')
      .filter({ has: page.getByRole('heading', { name: 'Old laptop' }) });
    await card.getByRole('button', { name: 'Revoke Old laptop' }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeVisible();
    await shoot(page, 'devices-revoke-dialog', { fullPage: false, viewports: ['desktop'] });
    await dialog.getByRole('button', { name: 'Revoke device' }).click();
    await expect(dialog).toBeHidden();
    await visit(page, '/devices');
    await shoot(page, 'devices');
  });

  await test.step('accounts', async () => {
    await visit(alice.page, zezima);
    await shoot(alice.page, 'account-owner-zezima', { waitMs: 800 });
    await visit(alice.page, lynx);
    await shoot(alice.page, 'account-owner-not-shared-lynx', { waitMs: 800 });
    // Iron Mira is carol's: alice sees the guild's view, plus the admin's sharing controls.
    const mira = await accountHref(carol.page, 'Iron Mira');
    await visit(alice.page, mira);
    await shoot(alice.page, 'account-admin-view-mira', { waitMs: 800 });
    // carol is a plain member: she sees what Zezima shares with the guild (everything, D-96).
    await visit(carol.page, zezima);
    await shoot(carol.page, 'account-member-view-zezima', { waitMs: 800 });
    await visit(alice.page, '/accounts/does-not-exist');
    await shoot(alice.page, 'account-not-found');
  });

  await test.step('guild, settings, privacy', async () => {
    await visit(alice.page, '/guild');
    await shoot(alice.page, 'guild', { waitMs: 300 });
    await visit(alice.page, '/settings');
    await shoot(alice.page, 'settings');
    await alice.page.getByRole('button', { name: 'Delete my data' }).click();
    const dialog = alice.page.getByRole('alertdialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('textbox').fill('delete');
    await shoot(alice.page, 'settings-delete-dialog', { fullPage: false });
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    await visit(alice.page, '/privacy');
    await shoot(alice.page, 'privacy');
    // carol's dashboard: her account, and alice's in "Online now".
    await visit(carol.page, '/');
    await shoot(carol.page, 'dashboard-member');
  });

  await test.step('api keys', async () => {
    const { page } = alice;
    await visit(page, '/api-keys');
    await shoot(page, 'api-keys-empty');
    await page.getByRole('button', { name: 'Create key' }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await shoot(page, 'api-keys-create-dialog', { fullPage: false });
    await dialog.getByLabel('Name').fill('Home Assistant');
    for (const i of [0, 1, 2]) await dialog.getByRole('checkbox').nth(i).check();
    await dialog.getByRole('radio', { name: /Only the accounts I pick/ }).check();
    await dialog.getByRole('group', { name: 'Accounts' }).getByRole('checkbox').first().check();
    await shoot(page, 'api-keys-create-filled', { fullPage: false });
    await dialog.getByRole('button', { name: 'Create key' }).click();
    await expect(dialog.getByLabel('API key', { exact: true })).toBeVisible();
    await shoot(page, 'api-keys-created', { fullPage: false });
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(dialog).toBeHidden();
    await visit(page, '/api-keys');
    await shoot(page, 'api-keys');
    // The header with every nav item (admins see six) around the lg breakpoint, where the menu
    // button gives way to the full navigation.
    const navShot = String(++shotNo).padStart(2, '0');
    for (const width of [820, 1024]) {
      await page.setViewportSize({ width, height: 600 });
      await settle(page);
      await page.screenshot({ path: path.join(OUT_DIR, `${navShot}-nav-${width}-light.png`) });
    }
    await page.setViewportSize({ width: VIEWPORTS[0].width, height: VIEWPORTS[0].height });
    // Public, and loads Scalar from jsDelivr: without internet access it shows its fallback link.
    await page.goto('/docs/api');
    await shoot(page, 'docs-api', { waitMs: 1500, fullPage: false });
  });

  await test.step('admin', async () => {
    for (const [url, name] of [
      ['/admin', 'admin-users'],
      ['/admin/devices', 'admin-devices'],
      ['/admin/integrations', 'admin-integrations'],
      ['/admin/ingest', 'admin-ingest'],
      ['/admin/payloads', 'admin-payloads'],
      ['/admin/audit', 'admin-audit'],
      ['/admin/settings', 'admin-settings'],
      ['/admin/config', 'admin-config'],
      ['/admin/decommission', 'admin-decommission'],
    ] as const) {
      await visit(alice.page, url);
      await shoot(alice.page, name, { waitMs: 500 });
    }
    await visit(alice.page, '/admin/payloads');
    await shoot(alice.page, 'admin-payload-dialog', {
      fullPage: false,
      before: async (page) => {
        await page
          .getByRole('button', { name: /^View payload/ })
          .nth(1)
          .click();
        await expect(page.getByRole('dialog', { name: 'Raw payload' })).toBeVisible();
        await expect(page.getByRole('status', { name: 'Loading the payload' })).toHaveCount(0);
      },
    });
  });

  // Last, so the drops it sends don't fill the timelines above: a drop while alice looks at the
  // dashboard, and its toast (below the header, on the right).
  await test.step('toast', async () => {
    await visit(alice.page, '/');
    await shoot(alice.page, 'toast', {
      fullPage: false,
      before: async (page) => {
        // One toast at a time: the last one has gone (EVENT_TOAST_DURATION_MS is 8 s).
        await expect(page.locator('[data-sonner-toast]')).toHaveCount(0, { timeout: 20_000 });
        await send(
          alice,
          aliceToken,
          payload('event-loot', Date.now(), Date.now(), (body) => {
            // The stats of the current state (the fixture's are a little older: an XP drop, D-24).
            (body.player as Record<string, unknown>).stats = (
              payloadFixture('snapshot-combat-burst-3').player as Record<string, unknown>
            ).stats;
          }),
        );
        await expect(page.locator('[data-sonner-toast]').first()).toBeVisible();
      },
    });
  });

  await carol.context.close();
  await alice.context.close();
});

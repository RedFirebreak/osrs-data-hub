/**
 * The pairing wizard end to end (handoff §6.3, §4.2), against the standalone build with a fake
 * Discord and a fresh database (see playwright.config.ts). The plugin is simulated with Playwright's
 * request API: it sends exactly what HA Exporter sends (headers, compact JSON bodies, the fixtures).
 *
 * The tests share one database: alice runs the wizard, carol (another member) pairs the device the
 * devices test revokes, so neither depends on the other having run.
 */
import { expect, test } from '@playwright/test';
import { GUILD_NAME, HUB_NAME, HUB_URL } from './env';
import {
  FakePlugin,
  actAsClient,
  freshPayload,
  newClientIp,
  payloadFixture,
  signInWithDiscord,
} from './support';

/** The account in the snapshot-normal and event-loot fixtures. */
const ZEZIMA = 'Zezima';

/**
 * How long a live message may take to show. Well below the wizard's 15 s safety poll (it polls every
 * 15 s while the stream is open), so these steps pass only when the live stream delivered them.
 */
const LIVE = { timeout: 5_000 };

test('a Discord user who is not in the guild is sent back to /login with an explanation', async ({
  page,
}) => {
  await actAsClient(page, newClientIp());
  await signInWithDiscord(page, 'bob');

  await expect(page).toHaveURL(/\/login\?error=not_guild_member(&|$)/);
  // (Next's route announcer is an empty role=alert too, hence the filter.)
  await expect(
    page.getByRole('alert').filter({ hasText: new RegExp(`not a member of ${GUILD_NAME}`, 'i') }),
  ).toBeVisible();
  // No session was created (AUTH-6): Home still sends bob to the login page.
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('button', { name: 'Sign in with Discord' })).toBeVisible();
});

test('a member pairs RuneLite with the wizard and sees the character on Home', async ({
  page,
  request,
}, testInfo) => {
  const ip = newClientIp();
  const plugin = new FakePlugin(request, ip);
  await actAsClient(page, ip);

  await signInWithDiscord(page, 'alice');
  await expect(page).toHaveURL(`${HUB_URL}/`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

  // The wizard's clock starts after sign-in (handoff §2: onboarded in under two minutes).
  const wizardStarted = performance.now();
  if (testInfo.retry === 0 && testInfo.repeatEachIndex === 0) {
    // A fresh user has no character: the empty state points to the wizard.
    await expect(
      page.getByRole('heading', { name: 'Connect RuneLite to see your character' }),
    ).toBeVisible();
    await page.getByRole('link', { name: 'Add your first device' }).click();
  } else {
    // Retries (and --repeat-each) share the database: alice already has the account, so Home is
    // her character. "Add device" lives on the devices page, in the avatar menu.
    await page.getByRole('button', { name: 'Open the account menu' }).click();
    await page.getByRole('menuitem', { name: 'Devices' }).click();
    await page.getByRole('main').getByRole('link', { name: 'Add device' }).click();
  }

  // Step 1: install the plugin, then on to the code.
  await expect(page).toHaveURL(`${HUB_URL}/onboarding`);
  await expect(page.getByRole('heading', { name: 'Install HA Exporter' })).toBeVisible();
  await page.getByRole('button', { name: 'Next: get a pairing code' }).click();

  // Step 2: a 5-digit code and the hub's base URL (APP_URL, scheme included; PLUGIN-13).
  await expect(page.getByRole('heading', { name: 'Pair RuneLite with the hub' })).toBeVisible();
  const codeBox = page.getByTestId('pairing-code');
  await expect(codeBox).toHaveAttribute('data-code', /^[0-9]{5}$/);
  const code = (await codeBox.getAttribute('data-code')) ?? '';
  await expect(page.getByTestId('pairing-url')).toHaveText(HUB_URL);
  await expect(page.getByText('Waiting for RuneLite to connect…')).toBeVisible();
  // The live stream is open (otherwise the wizard says it is polling instead).
  await expect(page.getByText(/Live updates are reconnecting/)).toBeHidden();

  // The plugin submits the code, but it's too old: 400, and the wizard says so.
  const tooOld = await plugin.pair(code, '1.4');
  expect(tooOld.status()).toBe(400);
  expect(await tooOld.json()).toMatchObject({ ok: false, error: expect.stringContaining('1.5') });
  const outdated = page.getByRole('alert').filter({ hasText: 'Update HA Exporter' });
  await expect(outdated).toBeVisible(LIVE);
  await expect(outdated).toContainText('Your HA Exporter is too old (version 1.4)');

  // After updating (RuneLite restart), the same code pairs: 200 with the token and the hub's name.
  const paired = await plugin.pair(code, '1.5');
  expect(paired.status()).toBe(200);
  expect(paired.headers()['cache-control']).toBe('no-store');
  const pairBody = (await paired.json()) as { ok: boolean; token: unknown; name: unknown };
  expect(pairBody).toMatchObject({ ok: true, name: HUB_NAME });
  expect(typeof pairBody.token).toBe('string');
  const token = pairBody.token as string;
  expect(token.length).toBeGreaterThanOrEqual(32);

  // Step 3: connected; waiting for the first data.
  await expect(page.getByText('RuneLite connected')).toBeVisible(LIVE);
  await expect(page.getByRole('heading', { name: 'Log in to see your first data' })).toBeVisible();
  await expect(outdated).toBeHidden();
  await expect(page.getByText('Waiting for the first data from this device…')).toBeVisible();

  // The player logs in: the plugin sends its first snapshot.
  const snapshot = await plugin.send(token, freshPayload('snapshot-normal'));
  expect(snapshot.status()).toBe(200);
  await expect(page.getByText(new RegExp(`Receiving data for ${ZEZIMA}\\b`))).toBeVisible(LIVE);
  await expect(page.getByText("You're the owner")).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();

  // Step 4: done. The owner sees who can see the account: everything is shared with the guild by
  // default (D-96), with the account page's controls to change it right there.
  await expect(page.getByRole('heading', { name: "You're all set" })).toBeVisible();
  const sharing = page.getByRole('region', { name: `Who can see ${ZEZIMA}` });
  for (const category of [
    'Stats',
    'Events',
    'Activity',
    'Live location',
    'Location history',
    'Equipment',
    'Inventory',
  ]) {
    await expect(sharing.getByLabel(category, { exact: true })).toHaveText('Guild');
  }
  // A change saves at once (and back again: retries share the database).
  const inventory = sharing.getByLabel('Inventory', { exact: true });
  await inventory.click();
  await page.getByRole('option', { name: /^Private/ }).click();
  await expect(inventory).toHaveText('Private');
  await expect(
    page.locator('[data-sonner-toast]').filter({ hasText: 'Inventory is now private' }),
  ).toBeVisible();
  await inventory.click();
  await page.getByRole('option', { name: /^Guild/ }).click();
  await expect(inventory).toHaveText('Guild');

  // On to Home: the character that was just paired.
  await page.getByRole('link', { name: 'Go to Home' }).click();
  await expect(page).toHaveURL(`${HUB_URL}/`);
  await expect(page.getByRole('heading', { level: 1, name: ZEZIMA })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Skills' })).toBeVisible();

  const wizardMs = Math.round(performance.now() - wizardStarted);
  console.log(`e2e: wizard flow (Home → paired → first data → Home) took ${wizardMs} ms`);
  testInfo.annotations.push({ type: 'wizard duration', description: `${wizardMs} ms` });
  expect(wizardMs, 'the wizard itself takes well under two minutes').toBeLessThan(60_000);

  // A drop arrives while alice looks at Home: a toast, top right, naming the account.
  const loot = payloadFixture('event-loot');
  expect((loot.player as { name?: string }).name).toBe(ZEZIMA);
  const drop = await plugin.send(token, freshPayload('event-loot'));
  expect(drop.status()).toBe(200);
  const toast = page.locator('[data-sonner-toast]').filter({ hasText: ZEZIMA });
  await expect(toast).toBeVisible(LIVE);
  await expect(toast).toContainText('Armadyl chestplate');
  await expect(page.locator('[data-sonner-toaster]')).toHaveAttribute('data-x-position', 'right');
  const box = await toast.boundingBox();
  const viewport = page.viewportSize();
  expect(box, 'toast is laid out').not.toBeNull();
  expect(viewport).not.toBeNull();
  if (box && viewport) {
    expect(box.x + box.width / 2).toBeGreaterThan(viewport.width / 2);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  }

  // The week leads on to Progress, which opens on the same character.
  const progressHref = await page.getByRole('link', { name: 'See progress' }).getAttribute('href');
  expect(progressHref).toMatch(/^\/progress\/[A-Za-z0-9]+$/);
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Progress' })
    .click();
  await expect(page).toHaveURL(`${HUB_URL}${progressHref}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Progress' })).toBeVisible();

  // The character page loaded directly answers 200 (an unknown one 404: see the devices test).
  const accountHref = (progressHref ?? '').replace('/progress/', '/accounts/');
  const accountPage = await page.goto(accountHref);
  expect(accountPage?.status()).toBe(200);
  await expect(page.getByRole('heading', { level: 1, name: ZEZIMA })).toBeVisible();

  // alice is an admin: the raw payload viewer's audited GET is same-origin only (D-80), and the
  // viewer's own fetch (Sec-Fetch-Site: same-origin, no Origin) gets through.
  await page.goto('/admin/payloads');
  await page
    .getByRole('button', { name: /^View payload/ })
    .first()
    .click();
  const payloadDialog = page.getByRole('dialog', { name: 'Raw payload' });
  await expect(payloadDialog.getByRole('region', { name: 'Payload body' })).toBeVisible();
  await expect(payloadDialog.getByRole('alert')).toHaveCount(0);
});

test('the devices page lists the paired device, and revoking it locks the plugin out', async ({
  page,
  request,
}) => {
  const ip = newClientIp();
  const plugin = new FakePlugin(request, ip);
  const label = `E2E laptop ${Date.now().toString(36)}`;
  await actAsClient(page, ip);

  await signInWithDiscord(page, 'carol');
  await expect(page).toHaveURL(`${HUB_URL}/`);
  // carol never reports an account, so her Home stays empty.
  await expect(
    page.getByRole('heading', { name: 'Connect RuneLite to see your character' }),
  ).toBeVisible();

  // Pair a device named in step 1 of the wizard.
  await page.goto('/onboarding');
  await page.getByLabel('Name this device (optional)').fill(label);
  await page.getByRole('button', { name: 'Next: get a pairing code' }).click();
  const codeBox = page.getByTestId('pairing-code');
  await expect(codeBox).toHaveAttribute('data-code', /^[0-9]{5}$/);
  const code = (await codeBox.getAttribute('data-code')) ?? '';

  // A reload mid-pairing resumes the same code (kept in the URL) instead of starting over.
  await expect(page).toHaveURL(/\/onboarding\?code=[0-9a-f-]{36}$/);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Pair RuneLite with the hub' })).toBeVisible();
  await expect(codeBox).toHaveAttribute('data-code', code);

  const paired = await plugin.pair(code, '1.5');
  expect(paired.status()).toBe(200);
  const { token } = (await paired.json()) as { token: string };
  await expect(page.getByText('RuneLite connected')).toBeVisible();

  // The token works: a payload without a player (the login screen) is accepted.
  const idle = { events: [], state: 'LOGIN_SCREEN', tickDelay: 0, timestamp: Date.now() };
  expect((await plugin.send(token, idle)).status()).toBe(200);

  // The device is listed with its name and plugin version.
  await page.goto('/devices');
  const connected = page.getByRole('region', { name: /^Connected devices/ });
  const card = connected
    .getByTestId('device-card')
    .filter({ has: page.getByRole('heading', { name: label }) });
  await expect(card).toBeVisible();
  await expect(card.locator('dt:text-is("Plugin version") + dd')).toHaveText('1.5');

  // Revoke it, behind the confirmation dialog.
  await card.getByRole('button', { name: `Revoke ${label}` }).click();
  const dialog = page.getByRole('alertdialog', { name: `Revoke ${label}?` });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Revoke device' }).click();
  await expect(dialog).toBeHidden();
  await expect(
    page.locator('[data-sonner-toast]').filter({ hasText: `${label} revoked` }),
  ).toBeVisible();
  const revoked = page.getByRole('region', { name: /^Revoked devices/ });
  await expect(
    revoked.getByTestId('device-card').filter({ has: page.getByRole('heading', { name: label }) }),
  ).toBeVisible();
  await expect(card).toBeHidden();
  // The Revoke button left with the card: the focus went to the section's heading, not to <body>.
  await expect(page.getByRole('heading', { level: 2, name: /^Connected devices/ })).toBeFocused();
  expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('BODY');

  // The plugin's next send is refused, which makes it disable the connection (handoff §3.2).
  const refused = await plugin.send(token, { ...idle, timestamp: Date.now() });
  expect(refused.status()).toBe(401);

  // An account that doesn't exist (or isn't visible) answers a real 404, not a streamed "soft
  // 404" with status 200 (NEXT-14).
  const missing = await page.goto('/accounts/Nothing00000');
  expect(missing?.status()).toBe(404);
  await expect(page.getByRole('heading', { level: 1, name: 'Account not found' })).toBeVisible();
});

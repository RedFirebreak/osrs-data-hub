/**
 * End-to-end tests of the pairing wizard (handoff §4.2 "Playwright (wizard end-to-end)", §2
 * "onboarded in under 2 minutes"). Run from the repo root with `pnpm test:e2e`.
 *
 * The server under test is the real standalone build (e2e/serve.mjs: `next build`, then
 * .next/standalone/apps/web/server.js) with Discord faked inside it (e2e/mock-discord.mjs) and a
 * fresh, migrated database per run (e2e/global-setup.ts). Needs Postgres/TimescaleDB at
 * TEST_DATABASE_URL (default postgres://hub:hub@127.0.0.1:5432/postgres), like the vitest suites.
 *
 * Environment:
 *   E2E_SKIP_BUILD=1     use the existing build (CI builds in an earlier step)
 *   PW_CHROMIUM_PATH     a Chromium binary to use instead of Playwright's own download
 *   E2E_KEEP_DB=1        keep the database after the run (its name is logged)
 *   E2E_LOG_LEVEL        the server's LOG_LEVEL (default warn)
 *   E2E_SCREENSHOTS=1    run only the visual QA screenshots (e2e/screenshots.spec.ts, tagged
 *                        @screenshots) instead of the tests; they are left out otherwise
 */
import { defineConfig, devices } from '@playwright/test';
import { AUTH_SECRET, E2E_DB, GUILD_NAME, HUB_NAME, HUB_PORT, HUB_URL } from './e2e/env';

const CI = !!process.env.CI;
const SCREENSHOTS = /@screenshots/;
const screenshotsOnly = process.env.E2E_SCREENSHOTS === '1';

export default defineConfig({
  testDir: './e2e',
  // The screenshot run is a separate job (it asserts nothing about behaviour and takes minutes).
  grep: screenshotsOnly ? SCREENSHOTS : undefined,
  grepInvert: screenshotsOnly ? undefined : SCREENSHOTS,
  // One server and one database: run the files one after another; the tests don't share state
  // through the browser, but they do through the database (see e2e/wizard.spec.ts).
  workers: 1,
  fullyParallel: false,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: CI ? [['list'], ['html', { open: 'never' }], ['github']] : [['list']],
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: HUB_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: { executablePath: process.env.PW_CHROMIUM_PATH || undefined },
      },
    },
  ],
  webServer: {
    command: 'node e2e/serve.mjs',
    // /login renders without a database: the server is up before global-setup.ts creates it (TOOL-8).
    url: `${HUB_URL}/login`,
    // `next build` runs first unless E2E_SKIP_BUILD=1.
    timeout: 300_000,
    // Always a fresh server: it must use this run's database.
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      HOSTNAME: '127.0.0.1',
      PORT: String(HUB_PORT),
      APP_URL: HUB_URL,
      HUB_NAME,
      DATABASE_URL: E2E_DB.url,
      AUTH_SECRET,
      DISCORD_CLIENT_ID: 'test',
      DISCORD_CLIENT_SECRET: 'test',
      DISCORD_GUILD_ID: '999',
      DISCORD_GUILD_NAME: GUILD_NAME,
      ADMIN_DISCORD_USER_IDS: '100000000000000001',
      // The tests stand in for several clients behind one trusted proxy (X-Forwarded-For), so each
      // gets its own sign-in and pairing rate-limit bucket (see e2e/support.ts).
      TRUST_PROXY_HOPS: '1',
      LOG_LEVEL: process.env.E2E_LOG_LEVEL ?? 'warn',
      NEXT_TELEMETRY_DISABLED: '1',
    },
  },
});

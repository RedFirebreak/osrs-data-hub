/**
 * Settings shared by playwright.config.ts, the global setup and the tests. The random values are
 * created once, in the runner process, and kept in process.env: Playwright loads the config again in
 * every worker, and workers inherit the runner's environment, so everyone sees the same database.
 */
import { randomBytes } from 'node:crypto';

/** Where the server under test listens (APP_URL). Never `localhost`: cookies are per host name. */
export const HUB_URL = 'http://127.0.0.1:3100';
export const HUB_PORT = 3100;
export const HUB_NAME = 'E2E Hub';
export const GUILD_NAME = 'Test Clan';

/** Admin connection that creates and drops the database (same default as the vitest setup). */
export const TEST_ADMIN_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://hub:hub@127.0.0.1:5432/postgres';

process.env.E2E_DB_NAME ??= `hub_e2e_${randomBytes(5).toString('hex')}`;
process.env.E2E_AUTH_SECRET ??= randomBytes(32).toString('hex');
if (!/^[a-z_][a-z0-9_]{0,62}$/.test(process.env.E2E_DB_NAME)) {
  throw new Error('E2E_DB_NAME must be a plain lower-case Postgres identifier');
}

function databaseUrl(name: string): string {
  const url = new URL(TEST_ADMIN_URL);
  url.pathname = `/${name}`;
  return url.toString();
}

/** The fresh database of this run (created by global-setup.ts). */
export const E2E_DB = {
  name: process.env.E2E_DB_NAME,
  url: databaseUrl(process.env.E2E_DB_NAME),
};

export const AUTH_SECRET = process.env.E2E_AUTH_SECRET;

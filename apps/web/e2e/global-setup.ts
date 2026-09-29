/**
 * Creates and migrates the fresh database the server under test uses, and drops it afterwards.
 *
 * See TOOL-8: Playwright starts the webServer BEFORE globalSetup runs, so the server boots against
 * a database that doesn't exist yet. That is fine: it connects lazily, and its live LISTEN
 * connection retries with backoff (1 s, 2 s, 4 s, …). Once the database exists, this waits until
 * that connection is in, so the first test's live messages (pairing, first data, toasts) aren't
 * sent into the void.
 */
import { runMigrations } from '@hub/db';
import pg from 'pg';
import { E2E_DB, TEST_ADMIN_URL } from './env';

/** application_name of the server's LISTEN connection (LIVE_LISTENER_APPLICATION_NAME, @hub/server). */
const LIVE_LISTENER = 'hub-live-listener';
const LISTENER_WAIT_MS = 60_000;

async function admin<T>(run: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: TEST_ADMIN_URL });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

async function waitForLiveListener(): Promise<void> {
  const deadline = Date.now() + LISTENER_WAIT_MS;
  for (;;) {
    const { rows } = await admin((c) =>
      c.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND application_name = $2',
        [E2E_DB.name, LIVE_LISTENER],
      ),
    );
    if ((rows[0]?.n ?? 0) > 0) return;
    if (Date.now() > deadline) {
      throw new Error(
        `The server's live listener didn't connect to ${E2E_DB.name} within ${LISTENER_WAIT_MS / 1000} s`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function dropDatabase(): Promise<void> {
  await admin((c) => c.query(`DROP DATABASE IF EXISTS ${E2E_DB.name} WITH (FORCE)`));
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const started = performance.now();
  await admin((c) => c.query(`CREATE DATABASE ${E2E_DB.name}`));
  try {
    await runMigrations(E2E_DB.url);
    await waitForLiveListener();
  } catch (err) {
    await dropDatabase().catch(() => {});
    throw err;
  }
  console.log(
    `e2e: database ${E2E_DB.name} ready in ${Math.round(performance.now() - started)} ms`,
  );
  return async () => {
    if (process.env.E2E_KEEP_DB === '1') {
      console.log(`e2e: kept database ${E2E_DB.name} (E2E_KEEP_DB=1)`);
      return;
    }
    await dropDatabase();
  };
}

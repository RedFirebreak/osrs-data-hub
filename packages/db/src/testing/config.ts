/** Admin connection used by tests to create and drop databases (never the app database). */
export const TEST_ADMIN_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://hub:hub@127.0.0.1:5432/postgres';

export const TEMPLATE_DB = 'hub_test_template';

export function urlForDatabase(adminUrl: string, database: string): string {
  const u = new URL(adminUrl);
  u.pathname = `/${database}`;
  return u.toString();
}

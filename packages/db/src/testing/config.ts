/** Admin connection used by tests to create and drop databases (never the app database). */
export const TEST_ADMIN_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://hub:hub@127.0.0.1:5432/postgres';

/** Prefix of the per-run template databases built by the vitest globalSetup. */
export const TEMPLATE_PREFIX = 'hub_tpl_';

export function urlForDatabase(adminUrl: string, database: string): string {
  const u = new URL(adminUrl);
  u.pathname = `/${database}`;
  return u.toString();
}

declare module 'vitest' {
  export interface ProvidedContext {
    /** Name of this run's migrated template database (see global-setup.ts). */
    hubTemplateDb: string;
  }
}

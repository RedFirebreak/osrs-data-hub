/**
 * One-shot migration entrypoint (compose `migrate` service, and `pnpm db:migrate` from source):
 * applies pending migrations, then exits. In the image the SQL files sit next to the bundle in
 * dist/drizzle (the migrator reads them from disk at runtime); from source they are read from
 * packages/db/drizzle.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { MIGRATIONS_DIR, runMigrations } from '@hub/db';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

const bundled = path.join(import.meta.dirname, 'drizzle');
const folder = existsSync(path.join(bundled, 'meta', '_journal.json')) ? bundled : MIGRATIONS_DIR;

try {
  await runMigrations(url, folder);
  console.log(JSON.stringify({ level: 'info', msg: 'migrations applied', folder }));
  process.exit(0);
} catch (err) {
  const code = (err as { cause?: { code?: string } })?.cause?.code;
  console.error(
    JSON.stringify({
      level: 'error',
      msg: 'migration failed',
      code,
      error: String((err as Error)?.cause ?? err).split('\n')[0],
    }),
  );
  process.exit(1);
}

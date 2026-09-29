// Preloaded (`node --import`) by the dev scripts: pnpm dev, pnpm dev:worker, pnpm db:migrate. Loads the
// repo-root .env, with .env.dev (dev-only overrides, e.g. DATABASE_URL on 127.0.0.1) on top. Neither
// Next nor tsx reads a .env above the package directory. A preload, not --env-file. See NEXT-15:
// `next dev` copies its Node flags into the dev server's NODE_OPTIONS, where Node refuses --env-file*.
// process.loadEnvFile never overwrites a variable that is already set, so the override file goes first
// and the shell beats both.
import { existsSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
for (const file of ['.env.dev', '.env']) {
  const envPath = path.join(root, file);
  if (existsSync(envPath)) process.loadEnvFile(envPath);
}

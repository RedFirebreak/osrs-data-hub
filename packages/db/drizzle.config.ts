import { defineConfig } from 'drizzle-kit';

// Only `generate` and `check` are used. Never `push`/`pull` against a Timescale database (DB-6).
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './drizzle',
  strict: true,
  verbose: true,
});

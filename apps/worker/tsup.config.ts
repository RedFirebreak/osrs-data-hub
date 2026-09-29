import { defineConfig } from 'tsup';

// Production bundle: self-contained ESM files (workspace TS sources and npm deps inlined), so the
// runtime image needs no node_modules. SQL migrations are copied next to it by the Dockerfile.
export default defineConfig({
  entry: ['src/main.ts', 'src/migrate.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  splitting: true,
  noExternal: [/.*/],
  external: ['pg-native'], // optional native binding that pg require()s lazily
  // Bundled CJS deps (pg) call require("events"): ESM output has no `require` (TOOL-4).
  banner: {
    js: 'import { createRequire as __hubCreateRequire } from "node:module"; const require = __hubCreateRequire(import.meta.url);',
  },
});

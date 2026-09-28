// @ts-check
import path from 'node:path';
import js from '@eslint/js';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig([
  // Paths are relative to this file (repo root); eslint-config-next's own ignores only match at the
  // root, so they are re-declared with **/.
  globalIgnores([
    '**/.next/**',
    '**/dist/**',
    '**/coverage/**',
    '**/next-env.d.ts',
    '**/*.config.{js,mjs,ts}',
    '**/drizzle/meta/**',
    'docs/**',
    '.claude/**',
    'apps/web/src/components/ui/**',
  ]),

  // Plain TS packages + worker (Node).
  {
    files: ['packages/**/*.ts', 'apps/worker/**/*.ts'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: { globals: globals.node },
  },

  // Next app.
  {
    files: ['apps/web/**/*.{js,jsx,ts,tsx,mjs}'],
    extends: [nextVitals, nextTs],
    settings: {
      next: { rootDir: path.join(import.meta.dirname, 'apps/web') },
      // Required on ESLint 10: "detect" crashes eslint-plugin-react (see TOOL-3).
      react: { version: '19.3' },
    },
  },

  // Type-aware rules. `next typegen` must run first so PageProps/RouteContext exist.
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { attributes: false } }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
    },
  },
]);

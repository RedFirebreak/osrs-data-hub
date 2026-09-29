import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'core',
          root: './packages/core',
          include: ['src/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'db',
          root: './packages/db',
          include: ['src/**/*.test.ts'],
          environment: 'node',
          globalSetup: ['./src/testing/global-setup.ts'],
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
      {
        test: {
          name: 'server',
          root: './packages/server',
          include: ['src/**/*.test.ts'],
          environment: 'node',
          globalSetup: ['../db/src/testing/global-setup.ts'],
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
      {
        test: {
          name: 'worker',
          root: './apps/worker',
          include: ['src/**/*.test.ts'],
          environment: 'node',
          globalSetup: ['../../packages/db/src/testing/global-setup.ts'],
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
      {
        // Route handlers and server utilities of the Next app (no DOM).
        resolve: { tsconfigPaths: true },
        test: {
          name: 'web',
          root: './apps/web',
          include: ['src/**/*.test.{ts,tsx}'],
          environment: 'node',
          globalSetup: ['../../packages/db/src/testing/global-setup.ts'],
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});

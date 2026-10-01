/**
 * The checked-in copy of the OpenAPI document (docs/openapi.json), which the project website renders as
 * its API reference without a running hub. Built with a placeholder APP_URL; the test fails when the
 * document changes and the copy wasn't refreshed. Refresh it with `pnpm openapi:update`.
 */
import path from 'node:path';
import { parseConfig, setConfigForTests } from '@hub/core';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { buildOpenApiDocument } from './openapi';

const SNAPSHOT = path.resolve(import.meta.dirname, '../../../../../docs/openapi.json');

beforeEach(() => {
  setConfigForTests(
    parseConfig({
      APP_URL: 'https://hub.example.com',
      HUB_NAME: 'osrs-data-hub',
      LOG_LEVEL: 'silent',
    }),
  );
});
afterEach(() => setConfigForTests(undefined));

it('matches the checked-in docs/openapi.json', async () => {
  await expect(`${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`).toMatchFileSnapshot(
    SNAPSHOT,
  );
});

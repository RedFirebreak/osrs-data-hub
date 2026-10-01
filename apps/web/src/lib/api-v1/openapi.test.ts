/**
 * The OpenAPI document (D-75) and its route: every route file under app/api/v1 is documented and
 * nothing else is; every operation has a 200 schema, its parameters and security (except the public
 * document itself); every $ref resolves; `servers` comes from APP_URL, never the request (NEXT-2);
 * the JSON round-trips; and GET /api/v1/openapi.json serves it publicly with CORS and caching.
 */
import { parseConfig, setConfigForTests } from '@hub/core';
import {
  API_RATE_LIMIT,
  EVENTS_MAX_LIMIT,
  MAX_BULK_ACCOUNTS as MAX_XP_ACCOUNTS,
  MAX_BULK_ACCOUNTS_SERVICE as MAX_XP_ACCOUNTS_SERVICE,
} from '@hub/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET, OPTIONS } from '@/app/api/v1/openapi.json/route';
import { v1RouteFiles } from '@/app/api/v1/route-files';
import { OPERATIONS, buildOpenApiDocument } from './openapi';

vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  connection: () => Promise.resolve(),
}));

/** OpenAPI paths of the route files under app/api/v1 (`[id]` → `{id}`), without the catch-all. */
function routePaths(): string[] {
  return v1RouteFiles()
    .filter((route) => !route.catchAll)
    .map(({ segments }) => `/${segments.map((s) => s.replace(/^\[(\w+)\]$/, '{$1}')).join('/')}`)
    .sort();
}

type Json = Record<string, unknown>;

function doc(): Json {
  return buildOpenApiDocument();
}

beforeEach(() => {
  setConfigForTests(
    parseConfig({
      APP_URL: 'https://hub.example.com',
      HUB_NAME: 'Example Hub',
      LOG_LEVEL: 'silent',
    }),
  );
});
afterEach(() => setConfigForTests(undefined));

describe('the OpenAPI document', () => {
  it('documents exactly the route files under app/api/v1', () => {
    const documented = Object.keys(doc().paths as Json).sort();
    expect(routePaths().length).toBeGreaterThanOrEqual(14);
    expect(documented).toEqual(routePaths());
  });

  it('is OpenAPI 3.1 with the servers URL from APP_URL', () => {
    const d = doc();
    expect(d.openapi).toBe('3.1.0');
    expect(d.info).toMatchObject({ title: 'osrs-data-hub API', version: '1' });
    expect(d.servers).toEqual([
      { url: 'https://hub.example.com/api/v1', description: 'Example Hub' },
    ]);
    expect((d.components as Json).securitySchemes).toEqual({
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'ohub_<prefix>_<secret>',
        description: expect.any(String) as string,
      },
    });
  });

  it('gives every operation a 200 schema and security (except the public document)', () => {
    const paths = doc().paths as Record<string, { get: Json }>;
    for (const [p, item] of Object.entries(paths)) {
      const op = item.get;
      const ok = (op.responses as Json)['200'] as Json;
      const schema = ((ok.content as Json)['application/json'] as Json).schema as Json;
      expect(schema, p).toBeTruthy();
      if (p === '/openapi.json') {
        expect(op.security, p).toEqual([]);
        continue;
      }
      expect(op.security, p).toEqual([{ bearerAuth: [] }]);
      expect(schema.$ref, p).toMatch(/^#\/components\/schemas\/\w+Response$/);
      for (const status of ['401', '429', '503']) {
        expect((op.responses as Json)[status], `${p} ${status}`).toBeTruthy();
      }
    }
    const snapshot = paths['/snapshot']?.get.responses as Json;
    expect(snapshot['304']).toBeTruthy();
  });

  it('documents path and query parameters with the server’s caps', () => {
    const paths = doc().paths as Record<string, { get: { parameters?: Json[] } }>;
    const params = (p: string) => paths[p]?.get.parameters ?? [];
    expect(params('/accounts/{id}')).toEqual([
      expect.objectContaining({ name: 'id', in: 'path', required: true }),
    ]);
    expect(params('/events').map((q) => q.name)).toEqual([
      'cursor',
      'types',
      'accounts',
      'min_value',
      'limit',
    ]);
    const limit = params('/events').find((q) => q.name === 'limit');
    expect(limit?.description).toContain(String(EVENTS_MAX_LIMIT));
    const accounts = params('/xp').find((q) => q.name === 'accounts');
    expect(accounts).toMatchObject({ required: true });
    expect(accounts?.description).toContain(String(MAX_XP_ACCOUNTS));
    expect(accounts?.description).toContain(String(MAX_XP_ACCOUNTS_SERVICE));
    expect(params('/locations').map((q) => q.name)).toEqual(['accounts', 'from', 'to']);
    expect(params('/snapshot').map((q) => q.name)).toEqual(['since']);
    expect((doc().info as Json).description).toContain(`${API_RATE_LIMIT} requests`);
  });

  it('resolves every $ref and round-trips through JSON', () => {
    const d = doc();
    const text = JSON.stringify(d);
    expect(JSON.parse(text)).toEqual(d);
    const refs = [...text.matchAll(/"\$ref":"([^"]+)"/g)].map((m) => m[1] ?? '');
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of new Set(refs)) {
      const target = ref
        .replace(/^#\//, '')
        .split('/')
        .reduce<unknown>((node, key) => (node as Json | undefined)?.[key], d);
      expect(target, ref).toBeTruthy();
    }
    expect(text).not.toContain('__shared');
    expect(text).not.toContain('"$schema"');
  });

  it('lists each documented operation once', () => {
    const ids = OPERATIONS.map((o) => o.operationId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('GET /api/v1/openapi.json', () => {
  it('serves the document without a key, with CORS and 5 minutes of caching', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=300');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    const body = (await res.json()) as Json;
    expect(body.openapi).toBe('3.1.0');
    expect(OPTIONS().status).toBe(204);
  });
});

/**
 * /docs/api (D-75): public (no session needed), titled with the hub's name, pointing Scalar at the
 * OpenAPI document with a raw-document fallback, and loading Scalar from an exact version with SRI.
 */
import { renderToReadableStream } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withTestDb, type WebTestContext } from '@/lib/test-utils';
import ApiDocsPage, { generateMetadata } from './page';
import { SCALAR_CONFIG, SCALAR_INTEGRITY, SCALAR_SRC, SCALAR_VERSION } from './scalar';

vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  connection: () => Promise.resolve(),
}));

let ctx: WebTestContext;

beforeAll(async () => {
  ctx = await withTestDb({ label: 'apidocs' });
});
afterAll(() => ctx.cleanup());

describe('/docs/api', () => {
  it('renders without a session and links to the OpenAPI document', async () => {
    const stream = await renderToReadableStream(await ApiDocsPage());
    await stream.allReady;
    const html = await new Response(stream).text();
    expect(html).toContain('Test Hub');
    expect(html).toContain('href="/api/v1/openapi.json"');
    expect(html).toContain('href="/api-keys"');
    expect(html).toContain('<noscript>');
    expect(generateMetadata().title).toBe('API reference · Test Hub');
  });

  it('pins Scalar to an exact version with a sha384 integrity hash', () => {
    expect(SCALAR_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(SCALAR_SRC).toBe(
      `https://cdn.jsdelivr.net/npm/@scalar/api-reference@${SCALAR_VERSION}/dist/browser/standalone.js`,
    );
    expect(SCALAR_INTEGRITY).toMatch(/^sha384-[A-Za-z0-9+/]{64}$/);
    expect(SCALAR_CONFIG).toMatchObject({ telemetry: false, withDefaultFonts: false });
  });
});

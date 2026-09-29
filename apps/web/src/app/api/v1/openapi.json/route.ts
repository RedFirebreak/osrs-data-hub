/**
 * GET /api/v1/openapi.json (D-75): the OpenAPI 3.1 document of API v1, generated at request time from
 * the zod schemas the routes use (lib/api-v1/openapi.ts). Public: no key and no rate limit; CORS like
 * every v1 route, so browser tools can load it. Cached by clients for 5 minutes.
 */
import { connection } from 'next/server';
import { preflight, withCors } from '@/lib/api-v1/cors';
import { measureApiRequest } from '@/lib/api-v1/metrics';
import { buildOpenApiDocument } from '@/lib/api-v1/openapi';
import { handleApi, json } from '@/lib/http';

export async function GET(): Promise<Response> {
  const done = measureApiRequest('openapi');
  const res = await handleApi(async () => {
    // Built per request: `servers` comes from APP_URL at run time, not at build time (NEXT-2).
    await connection();
    return json(200, buildOpenApiDocument(), { 'Cache-Control': 'public, max-age=300' });
  });
  return done(withCors(res));
}

export const OPTIONS = preflight;

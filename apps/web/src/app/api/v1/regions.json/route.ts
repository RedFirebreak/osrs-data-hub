/**
 * GET /api/v1/regions.json (D-138): the place names the hub gives map regions (`region` on locations),
 * so a client such as the live map names places exactly as the hub does, from one copy. Public like
 * the OpenAPI document: no key and no rate limit; the names are RuneLite's (BSD-2-Clause), not guild
 * data. Cached by clients for a day: they change only with a hub release.
 */
import { REGION_NAMES, REGION_NAMES_SOURCE } from '@hub/core';
import { preflight, withCors } from '@/lib/api-v1/cors';
import { measureApiRequest } from '@/lib/api-v1/metrics';
import { handleApi, json } from '@/lib/http';

export async function GET(): Promise<Response> {
  const done = measureApiRequest('regions');
  const res = await handleApi(() =>
    json(
      200,
      { source: REGION_NAMES_SOURCE, regions: Object.fromEntries(REGION_NAMES) },
      { 'Cache-Control': 'public, max-age=86400' },
    ),
  );
  return done(withCors(res));
}

export const OPTIONS = preflight;

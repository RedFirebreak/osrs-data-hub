/** GET /api/v1/regions.json (D-138): the place names, public, with CORS and a day of caching. */
import { REGION_NAMES, regionName } from '@hub/core';
import { describe, expect, it } from 'vitest';
import { GET, OPTIONS } from './regions.json/route';

describe('GET /api/v1/regions.json', () => {
  it('serves every name without a key, cached for a day', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=86400');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    const body = (await res.json()) as { source: string; regions: Record<string, string> };
    expect(body.source).toMatch(/BSD-2-Clause/);
    expect(Object.keys(body.regions)).toHaveLength(REGION_NAMES.size);
    // The name a location's `region` carries for Lumbridge is the one served here.
    expect(body.regions['12850']).toBe(regionName(3222, 3218));
    expect(OPTIONS().status).toBe(204);
  });
});

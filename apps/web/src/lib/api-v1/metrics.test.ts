import { API_ROUTE_GROUPS } from '@hub/server';
import { describe, expect, it } from 'vitest';
import { v1RouteFiles } from '@/app/api/v1/route-files';
import { apiRouteGroup } from './metrics';

describe('apiRouteGroup', () => {
  it('names the route group from the first path segment after /api/v1', () => {
    const base = 'https://hub.example.com';
    expect(apiRouteGroup(`${base}/api/v1/me`)).toBe('me');
    expect(apiRouteGroup(`${base}/api/v1/accounts`)).toBe('accounts');
    expect(apiRouteGroup(`${base}/api/v1/accounts/AbC123dEf456/xp?from=x`)).toBe('accounts');
    expect(apiRouteGroup(`${base}/api/v1/events?after=5`)).toBe('events');
    expect(apiRouteGroup(`${base}/api/v1/snapshot`)).toBe('snapshot');
    expect(apiRouteGroup(`${base}/api/v1/xp`)).toBe('xp');
    expect(apiRouteGroup(`${base}/api/v1/locations?accounts=a,b`)).toBe('locations');
    expect(apiRouteGroup(`${base}/api/v1/leaderboards/gains`)).toBe('leaderboards');
    expect(apiRouteGroup(`${base}/api/v1/members/100000000000000042`)).toBe('members');
    expect(apiRouteGroup(`${base}/api/v1/openapi.json`)).toBe('openapi');
  });

  it('has a group for every top-level route segment under app/api/v1, and no group without one', () => {
    // A new top-level route must be added to API_ROUTE_GROUPS (@hub/server metrics.ts), or its
    // requests would be counted as 'unknown' without anyone noticing.
    const segments = new Set(
      v1RouteFiles()
        .filter((route) => !route.catchAll)
        .map((route) => route.segments[0] ?? ''),
    );
    expect(segments.size).toBeGreaterThanOrEqual(8);
    const groups = [...segments].map((segment) => {
      const group = apiRouteGroup(`https://hub.example.com/api/v1/${segment}`);
      expect(group, `/api/v1/${segment}`).not.toBe('unknown');
      return group;
    });
    expect([...groups, 'unknown'].sort()).toEqual([...API_ROUTE_GROUPS].sort());
  });

  it("answers 'unknown' for anything else, so client paths never become labels (D-53)", () => {
    const base = 'https://hub.example.com';
    for (const path of ['/api/v1', '/api/v1/', '/api/v1/AbC123dEf456', '/api/v2/me', '/metrics']) {
      expect(apiRouteGroup(`${base}${path}`), path).toBe('unknown');
    }
  });
});

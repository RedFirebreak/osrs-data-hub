import { describe, expect, it } from 'vitest';
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
    expect(apiRouteGroup(`${base}/api/v1/leaderboards/gains`)).toBe('leaderboards');
    expect(apiRouteGroup(`${base}/api/v1/openapi.json`)).toBe('openapi');
  });

  it("answers 'unknown' for anything else, so client paths never become labels (D-53)", () => {
    const base = 'https://hub.example.com';
    for (const path of ['/api/v1', '/api/v1/', '/api/v1/AbC123dEf456', '/api/v2/me', '/metrics']) {
      expect(apiRouteGroup(`${base}${path}`), path).toBe('unknown');
    }
  });
});

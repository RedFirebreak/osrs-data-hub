/**
 * The redirects of next.config.ts: the addresses the Metrics tab had before it moved under /progress
 * (D-112) still lead somewhere, and nothing under /api is ever redirected (PLUGIN-2).
 */
import { describe, expect, it } from 'vitest';
import nextConfig from '../next.config';

describe('redirects', () => {
  it('sends the old Metrics addresses to their Progress pages, for good', async () => {
    const redirects = await nextConfig.redirects!();
    expect(redirects).toEqual([
      {
        source: '/accounts/:publicId/metrics',
        destination: '/progress/:publicId/deep-dive',
        permanent: true,
      },
      {
        source: '/accounts/:publicId/metrics/bosses/:activity',
        destination: '/progress/:publicId/bosses/:activity',
        permanent: true,
      },
    ]);
  });

  it('never touches an API or plugin endpoint', async () => {
    for (const { source } of await nextConfig.redirects!()) {
      expect(source.startsWith('/api')).toBe(false);
    }
  });
});

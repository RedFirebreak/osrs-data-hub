import { describe, expect, it } from 'vitest';
import { trackedSince } from './xp-chart-panel';

describe('trackedSince', () => {
  const from = new Date('2026-08-01T00:00:00.000Z');
  // 22:30 UTC on the 29th: already the 30th in Tokyo, still the 29th in Los Angeles, so at most one
  // of the two can be the zone the tests run in.
  const firstSeen = '2026-08-29T22:30:00.000Z';

  it("names the day the hub first saw the account in the viewer's time zone", () => {
    expect(trackedSince(firstSeen, from, 'Asia/Tokyo')).toBe(
      'since 30 Aug, when the hub first saw this account',
    );
    expect(trackedSince(firstSeen, from, 'America/Los_Angeles')).toBe(
      'since 29 Aug, when the hub first saw this account',
    );
  });

  it('says nothing when the account is older than the range, or its first-seen time is unusable', () => {
    expect(trackedSince('2026-07-01T00:00:00.000Z', from, 'UTC')).toBeNull();
    expect(trackedSince(from.toISOString(), from, 'UTC')).toBeNull();
    expect(trackedSince('not a date', from, 'UTC')).toBeNull();
  });
});

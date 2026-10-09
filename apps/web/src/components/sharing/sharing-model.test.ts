import type { SharingSettings } from '@hub/server';
import { describe, expect, it } from 'vitest';
import {
  audienceLabel,
  changeFailureMessage,
  errorMessage,
  grantCandidates,
  successMessage,
  transferCandidates,
} from './sharing-model';

function contributor(userId: string, role: 'owner' | 'contributor', blocked = false) {
  return {
    userId,
    name: userId,
    image: null,
    role,
    blocked,
    firstSeen: '2026-09-01T00:00:00.000Z',
    lastSeen: '2026-09-29T00:00:00.000Z',
  };
}

const settings: Pick<SharingSettings, 'categories' | 'contributors'> = {
  categories: [
    {
      category: 'inventory',
      audience: 'selected',
      isDefault: false,
      grants: [{ userId: 'granted', name: 'Granted' }],
    },
  ],
  contributors: [
    contributor('owner', 'owner'),
    contributor('player', 'contributor'),
    contributor('blocked', 'contributor', true),
  ],
};

const members = ['owner', 'player', 'blocked', 'granted', 'Émile', 'zed'].map((n) => ({
  userId: n,
  name: n,
  image: null,
}));

describe('grantCandidates', () => {
  it('leaves out granted members and the account’s own (non-blocked) players', () => {
    expect(grantCandidates(members, settings, 'inventory').map((m) => m.userId)).toEqual([
      'blocked',
      'Émile',
      'zed',
    ]);
    // Another category has no grants yet.
    expect(grantCandidates(members, settings, 'stats').map((m) => m.userId)).toContain('granted');
  });

  it('filters by name, ignoring case and accents', () => {
    expect(grantCandidates(members, settings, 'inventory', ' emi').map((m) => m.name)).toEqual([
      'Émile',
    ]);
  });
});

describe('transferCandidates', () => {
  it('offers non-blocked contributors only', () => {
    expect(transferCandidates(settings.contributors).map((c) => c.userId)).toEqual(['player']);
  });
});

describe('messages', () => {
  it('describes a successful change', () => {
    expect(
      successMessage(
        { action: 'audience', category: 'stats', audience: 'selected' },
        { category: 'Stats' },
      ),
    ).toBe('Stats is now selected people');
    expect(
      successMessage(
        { action: 'grant', category: 'inventory', userId: 'x' },
        { category: 'Inventory', user: 'Zed' },
      ),
    ).toBe('Zed can now see inventory');
    expect(successMessage({ action: 'claim' })).toBe('You now own this account');
    expect(successMessage({ action: 'hide', hidden: true })).toBe(
      'Hidden from the guild: only its players see this account',
    );
    expect(successMessage({ action: 'hide', hidden: false })).toBe(
      'Shown to the guild again, as set below',
    );
    expect(audienceLabel('guild')).toBe('Guild');
  });

  it("turns the hub's error fragments into sentences", () => {
    expect(errorMessage("the owner can't be blocked", 'x')).toBe("The owner can't be blocked.");
    expect(errorMessage('Done!', 'x')).toBe('Done!');
    expect(errorMessage(undefined, 'Fallback.')).toBe('Fallback.');
  });

  it('says why a change was not saved', () => {
    const body = { error: { code: 'invalid', message: "the owner can't be blocked" } };
    expect(changeFailureMessage(400, body)).toBe("The owner can't be blocked.");
    expect(changeFailureMessage(403, null)).toBe("That change couldn't be saved.");
    expect(changeFailureMessage(500, {})).toBe("That change couldn't be saved.");
    expect(changeFailureMessage(0, null)).toBe(
      "That change couldn't be saved. Check your connection and try again.",
    );
    // A session that ended is said as on every other page, not as the hub's "sign in first".
    expect(changeFailureMessage(401, { error: { message: 'not signed in' } })).toBe(
      'Your session has ended. Sign in again.',
    );
  });
});

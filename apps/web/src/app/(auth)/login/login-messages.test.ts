import { describe, expect, it } from 'vitest';
import { loginErrorMessage, normalizeErrorCode } from './login-messages';

describe('loginErrorMessage', () => {
  it('is null without an error', () => {
    expect(loginErrorMessage(undefined, 'Test Clan')).toBeNull();
    expect(loginErrorMessage('', 'Test Clan')).toBeNull();
  });

  it('names the guild for membership and role failures', () => {
    expect(loginErrorMessage('not_guild_member', 'Test Clan')?.message).toBe(
      "You're not a member of Test Clan. Join the Discord server, then try again.",
    );
    expect(loginErrorMessage('missing_role', 'Test Clan')?.message).toBe(
      "You're in Test Clan but don't have a role that gives access. Ask an admin.",
    );
  });

  it('explains Discord outages, admin revocation and cancelled consent', () => {
    expect(loginErrorMessage('discord_unavailable', 'x')?.message).toBe(
      "We couldn't reach Discord to check your membership. Try again in a minute.",
    );
    expect(loginErrorMessage('access_revoked', 'x')?.message).toBe('An admin removed your access.');
    expect(loginErrorMessage('access_denied', 'x')?.title).toBe('Sign-in cancelled');
  });

  it('matches codes case-insensitively and takes the first of repeated params', () => {
    expect(loginErrorMessage('NOT_GUILD_MEMBER', 'G')?.title).toBe('Not a member');
    expect(loginErrorMessage(['missing_role', 'x'], 'G')?.title).toBe('No access role');
  });

  it('shows other codes generically, and never echoes anything that is not a plain code', () => {
    expect(loginErrorMessage('state_mismatch', 'G')?.message).toContain(
      'Sign-in failed (state_mismatch)',
    );
    const injected = loginErrorMessage('<script>alert(1)</script> call +1 555', 'G');
    expect(injected?.message).toContain('Sign-in failed (unknown_error)');
    expect(injected?.message).not.toContain('script');
  });
});

describe('normalizeErrorCode', () => {
  it('accepts identifiers only', () => {
    expect(normalizeErrorCode(' Missing_Role ')).toBe('missing_role');
    expect(normalizeErrorCode('a b')).toBeNull();
    expect(normalizeErrorCode('x'.repeat(65))).toBeNull();
    expect(normalizeErrorCode(42)).toBeNull();
  });
});

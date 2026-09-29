import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { safeCallbackPath, signInWithDiscord, signOut } from './auth-client';

// Better Auth's client answers `{ data, error }` and doesn't throw on an HTTP error.
const client = vi.hoisted(() => ({
  signOut: vi.fn<() => Promise<{ data: unknown; error: unknown }>>(),
  social: vi.fn<(opts: unknown) => Promise<{ data: unknown; error: unknown }>>(),
}));
vi.mock('better-auth/react', () => ({
  createAuthClient: () => ({ signOut: client.signOut, signIn: { social: client.social } }),
}));

describe('safeCallbackPath', () => {
  it('keeps paths on this site', () => {
    for (const path of ['/', '/accounts/abc123', '/settings?tab=toasts', '/feed#top']) {
      expect(safeCallbackPath(path)).toBe(path);
    }
  });

  it('turns anything that could leave the site into /', () => {
    for (const path of [
      '',
      'https://evil.example.com/',
      'evil.example.com',
      '//evil.example.com',
      '/\\evil.example.com',
      '/\\/evil.example.com',
      // Browsers drop tabs and newlines from URLs: these become //evil.example.com.
      '/\t/evil.example.com',
      '/\n/evil.example.com',
      '/\r/evil.example.com',
      // Next's router and some proxies decode these into // before resolving.
      '/%2F/evil.example.com',
      '/%5C/evil.example.com',
      'javascript:alert(1)',
    ]) {
      expect(safeCallbackPath(path)).toBe('/');
    }
  });
});

describe('signOut / signInWithDiscord', () => {
  const assign = vi.fn();
  beforeEach(() => {
    vi.stubGlobal('window', { location: { assign } });
    assign.mockReset();
    client.signOut.mockReset();
    client.social.mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('signOut navigates only once the session is really gone', async () => {
    client.signOut.mockResolvedValue({ data: { success: true }, error: null });
    await signOut('/login');
    expect(assign).toHaveBeenCalledWith('/login');
  });

  it('signOut throws (the caller shows a toast) instead of leaving a signed-in user on /login', async () => {
    client.signOut.mockResolvedValue({
      data: null,
      error: { status: 403, statusText: 'Forbidden', message: 'Invalid origin' },
    });
    await expect(signOut('/login')).rejects.toThrow();
    expect(assign).not.toHaveBeenCalled();
  });

  it('signInWithDiscord throws when the sign-in could not start (429, 5xx)', async () => {
    client.social.mockResolvedValue({
      data: null,
      error: { status: 429, statusText: 'Too Many Requests' },
    });
    await expect(signInWithDiscord('/\t/evil.example.com')).rejects.toThrow();
    expect(client.social).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'discord', callbackURL: '/' }),
    );

    client.social.mockResolvedValue({
      data: { url: 'https://discord.com/…', redirect: true },
      error: null,
    });
    await expect(signInWithDiscord('/settings')).resolves.toBeUndefined();
  });
});

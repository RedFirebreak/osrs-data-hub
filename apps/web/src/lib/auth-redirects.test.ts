import { describe, expect, it } from 'vitest';
import { keepErrorsOnSite, offSiteError } from './auth-redirects';

const HUB = 'https://hub.example';

function redirect(location: string, status = 302): Response {
  return new Response(null, {
    status,
    headers: { location, 'set-cookie': 'a=b; Path=/' },
  });
}

function req(path: string): Request {
  return new Request(`${HUB}${path}`);
}

describe('offSiteError', () => {
  it('names the error a redirect carries to another site', () => {
    expect(offSiteError('https://evil.example/cb?error=login_required&state=x', HUB)).toBe(
      'login_required',
    );
    expect(offSiteError('https://evil.example/cb#error=invalid_scope', HUB)).toBe('invalid_scope');
  });

  it('lets the hub, Discord and a code through', () => {
    expect(offSiteError('/login?error=invalid_client', HUB)).toBeNull();
    expect(offSiteError(`${HUB}/login?error=state_not_found`, HUB)).toBeNull();
    expect(offSiteError('https://discord.com/api/oauth2/authorize?client_id=1', HUB)).toBeNull();
    expect(
      offSiteError('https://claude.ai/api/mcp/auth_callback?code=abc&state=s', HUB),
    ).toBeNull();
  });
});

describe('keepErrorsOnSite', () => {
  it('turns an error redirect to another site into the login page', async () => {
    const res = await keepErrorsOnSite(
      req('/api/auth/oauth2/authorize'),
      redirect('https://evil.example/cb?error=login_required&error_description=x&iss=y'),
      HUB,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${HUB}/login?error=login_required`);
    expect(res.headers.get('set-cookie')).toBe('a=b; Path=/');
  });

  it('never puts an odd error value in the address', async () => {
    const res = await keepErrorsOnSite(
      req('/api/auth/oauth2/authorize'),
      redirect('https://evil.example/cb?error=%3Cscript%3E'),
      HUB,
    );
    expect(res.headers.get('location')).toBe(`${HUB}/login?error=invalid_request`);
  });

  it('leaves other redirects alone', async () => {
    for (const location of [
      'https://discord.com/api/oauth2/authorize?prompt=consent',
      'https://claude.ai/api/mcp/auth_callback?code=abc',
      `${HUB}/login?error=not_guild_member`,
    ]) {
      const original = redirect(location);
      expect(await keepErrorsOnSite(req('/api/auth/callback/discord'), original, HUB)).toBe(
        original,
      );
    }
  });

  it('rewrites the JSON answer a fetch gets', async () => {
    const res = await keepErrorsOnSite(
      req('/api/auth/oauth2/authorize'),
      Response.json({ redirect: true, url: 'https://evil.example/cb?error=invalid_scope' }),
      HUB,
    );
    expect(await res.json()).toEqual({ redirect: true, url: `${HUB}/login?error=invalid_scope` });
  });

  it('reads no JSON body outside the OAuth provider', async () => {
    const original = Response.json({ redirect: true, url: 'https://evil.example/?error=x' });
    expect(await keepErrorsOnSite(req('/api/auth/get-session'), original, HUB)).toBe(original);
  });
});

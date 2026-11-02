import { describe, expect, it } from 'vitest';
import { isOAuthSignIn, oauthContinueUrl } from './oauth-sign-in';

describe('isOAuthSignIn', () => {
  it('needs a signature and a client', () => {
    expect(isOAuthSignIn({ sig: 'x', client_id: 'c' })).toBe(true);
    expect(isOAuthSignIn({ client_id: 'c' })).toBe(false);
    expect(isOAuthSignIn({ sig: 'x' })).toBe(false);
    expect(isOAuthSignIn({ error: 'not_guild_member' })).toBe(false);
  });
});

describe('oauthContinueUrl', () => {
  it('drops the signing parameters and prompt=login, keeps the rest', () => {
    const url = oauthContinueUrl({
      client_id: 'c',
      redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      response_type: 'code',
      prompt: 'login consent',
      resource: 'https://hub.example/api/v1/mcp',
      sig: 's',
      exp: '1',
      ba_iat: '2',
      ba_param: ['client_id', 'exp'],
    });
    const parsed = new URL(url, 'https://hub.example');
    expect(parsed.pathname).toBe('/api/auth/oauth2/authorize');
    expect(Object.fromEntries(parsed.searchParams)).toEqual({
      client_id: 'c',
      redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      response_type: 'code',
      prompt: 'consent',
      resource: 'https://hub.example/api/v1/mcp',
    });
  });

  it('leaves out a prompt that was only login', () => {
    const url = oauthContinueUrl({ client_id: 'c', prompt: 'login', sig: 's' });
    expect(url).toBe('/api/auth/oauth2/authorize?client_id=c');
  });
});

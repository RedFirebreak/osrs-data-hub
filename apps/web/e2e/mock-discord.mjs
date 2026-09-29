// Fake Discord for the end-to-end tests, preloaded into the standalone Next server with
// NODE_OPTIONS="--import <abs path>/e2e/mock-discord.mjs" (see e2e/serve.mjs).
//
// It replaces globalThis.fetch for https://discord.com/* only; every other URL goes to the real fetch.
// Next wraps globalThis.fetch when it starts, after this module ran, so its wrapper calls this one.
// The browser half of the OAuth flow (the authorize page) is faked by the tests with page.route():
// Discord would redirect back with ?code=<code>, and the tests use the user's handle as the code.
//
//   POST /api/oauth2/token                    → access_token "at-<code>"
//   GET  /api/v10/users/@me                   → the Discord user of that token
//   GET  /api/v10/users/@me/guilds/<DISCORD_GUILD_ID>/member
//                                             → 200 member for members, 404 {code:10004} otherwise
//
// alice is a member (and an admin through ADMIN_DISCORD_USER_IDS), bob is not in the guild, carol is
// a plain member (the devices test uses her, so it doesn't depend on alice's wizard run).
const realFetch = globalThis.fetch;

/** @type {Record<string, { id: string, globalName: string, member: boolean }>} */
const PEOPLE = {
  alice: { id: '100000000000000001', globalName: 'Alice', member: true },
  bob: { id: '100000000000000002', globalName: 'Bob', member: false },
  carol: { id: '100000000000000003', globalName: 'Carol', member: true },
};

const GUILD_ID = process.env.DISCORD_GUILD_ID ?? '999';

const MEMBER = {
  alice: { nick: 'Ali', roles: ['R1'], avatar: null },
  carol: { nick: null, roles: ['R1'], avatar: null },
};

function urlOf(input) {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

globalThis.fetch = async function mockDiscordFetch(input, init) {
  const url = urlOf(input);
  if (!url.startsWith('https://discord.com/')) return realFetch(input, init);

  // Normalise (string | URL | Request, init) into one Request to read method, headers and body.
  const req = new Request(input, init);
  const { pathname } = new URL(req.url);

  if (req.method === 'POST' && pathname === '/api/oauth2/token') {
    const code = new URLSearchParams(await req.text()).get('code') ?? '';
    return json(200, {
      access_token: `at-${code}`,
      token_type: 'Bearer',
      expires_in: 604800,
      refresh_token: `rt-${code}`,
      scope: 'identify guilds.members.read',
    });
  }

  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer at-/, '');
  const person = Object.hasOwn(PEOPLE, token) ? PEOPLE[token] : undefined;
  if (!person) return json(401, { message: '401: Unauthorized', code: 0 });

  if (/^\/api(\/v\d+)?\/users\/@me$/.test(pathname)) {
    return json(200, {
      id: person.id,
      username: token,
      global_name: person.globalName,
      discriminator: '0',
      avatar: null,
    });
  }

  if (/^\/api(\/v\d+)?\/users\/@me\/guilds\/[^/]+\/member$/.test(pathname)) {
    if (!person.member || !pathname.includes(`/guilds/${GUILD_ID}/`)) {
      return json(404, { message: 'Unknown Guild', code: 10004 });
    }
    return json(200, { ...MEMBER[token], joined_at: '2024-01-01T00:00:00.000000+00:00' });
  }

  return json(404, { message: '404: Not Found', code: 0 });
};

/**
 * Minimal Discord REST client for membership checks. Only two calls:
 *  - as the USER (OAuth token, scope guilds.members.read) at sign-in;
 *  - as the BOT (no permissions, no privileged intents) for the 6-hourly re-verification.
 */
export const DISCORD_API = 'https://discord.com/api/v10';

export interface DiscordUser {
  id: string;
  username: string;
  global_name?: string | null;
  avatar?: string | null;
  discriminator?: string;
}

export interface DiscordGuildMember {
  user?: DiscordUser;
  nick?: string | null;
  /** Guild-specific avatar hash. */
  avatar?: string | null;
  /** Never includes @everyone. */
  roles: string[];
  joined_at?: string | null;
  /** True while the member hasn't passed Membership Screening. */
  pending?: boolean;
}

/**
 * Result of a member lookup. `not_member` is only returned when Discord says so definitively:
 *  - user route: 404 (the user's own guild membership);
 *  - bot route: 404 with code 10007 "Unknown Member". A 404 with 10004 "Unknown Guild" means the bot
 *    isn't in the guild or DISCORD_GUILD_ID is wrong: that is a config error, never "left the guild"
 *    (DISCORD-1).
 */
export type MemberLookup =
  | { kind: 'member'; member: DiscordGuildMember }
  | { kind: 'not_member' }
  | {
      kind: 'error';
      status: number;
      code?: number;
      reason: 'config' | 'auth' | 'rate_limited' | 'unavailable';
    };

export type FetchFn = typeof fetch;

interface LookupOptions {
  fetchFn?: FetchFn;
  /** Max 429 retries honouring retry_after (default 2). */
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function lookup(
  url: string,
  authorization: string,
  route: 'user' | 'bot',
  opts: LookupOptions,
): Promise<MemberLookup> {
  const fetchFn = opts.fetchFn ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const maxRetries = opts.maxRetries ?? 2;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetchFn(url, {
        headers: { authorization, 'user-agent': 'osrs-data-hub (membership check)' },
        signal: opts.signal ?? AbortSignal.timeout(10_000),
      });
    } catch {
      return { kind: 'error', status: 0, reason: 'unavailable' };
    }
    if (res.ok) {
      const member = (await res.json()) as DiscordGuildMember;
      return {
        kind: 'member',
        member: { ...member, roles: Array.isArray(member.roles) ? member.roles : [] },
      };
    }
    const body = (await res.json().catch(() => null)) as {
      code?: number;
      retry_after?: number;
    } | null;
    const code = typeof body?.code === 'number' ? body.code : undefined;
    if (res.status === 429) {
      if (attempt >= maxRetries)
        return { kind: 'error', status: 429, code, reason: 'rate_limited' };
      const retryAfterS =
        typeof body?.retry_after === 'number'
          ? body.retry_after
          : Number(res.headers.get('retry-after') ?? '1') || 1;
      await sleep(Math.min(60_000, Math.max(250, Math.ceil(retryAfterS * 1000))));
      continue;
    }
    if (res.status === 404) {
      if (route === 'user') return { kind: 'not_member' };
      if (code === 10007) return { kind: 'not_member' };
      return { kind: 'error', status: 404, code, reason: 'config' };
    }
    if (res.status === 401 || res.status === 403)
      return { kind: 'error', status: res.status, code, reason: 'auth' };
    return { kind: 'error', status: res.status, code, reason: 'unavailable' };
  }
}

/** GET /users/@me/guilds/{guild}/member with the user's OAuth token. */
export function fetchOwnGuildMember(
  accessToken: string,
  guildId: string,
  opts: LookupOptions = {},
) {
  return lookup(
    `${DISCORD_API}/users/@me/guilds/${encodeURIComponent(guildId)}/member`,
    `Bearer ${accessToken}`,
    'user',
    opts,
  );
}

/** GET /guilds/{guild}/members/{user} with the bot token (no privileged intent needed). */
export function fetchGuildMemberAsBot(
  botToken: string,
  guildId: string,
  userId: string,
  opts: LookupOptions = {},
) {
  return lookup(
    `${DISCORD_API}/guilds/${encodeURIComponent(guildId)}/members/${encodeURIComponent(userId)}`,
    `Bot ${botToken}`,
    'bot',
    opts,
  );
}

/** GET /users/@me with the user's OAuth token. */
export async function fetchCurrentUser(
  accessToken: string,
  fetchFn: FetchFn = fetch,
): Promise<DiscordUser | null> {
  try {
    const res = await fetchFn(`${DISCORD_API}/users/@me`, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok ? ((await res.json()) as DiscordUser) : null;
  } catch {
    return null;
  }
}

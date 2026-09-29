/**
 * What the login page says for `/login?error=<code>`. The codes come from the sign-in gate in
 * lib/auth.ts (user.validateUserInfo and the session hook, AUTH-6), from Better Auth itself, and from
 * Discord (a user cancelling on the consent screen). Only the mapped text and a sanitized code are
 * ever shown: `error_description` is attacker-controllable and is never rendered.
 */

export interface LoginErrorMessage {
  title: string;
  message: string;
}

/** The error code, lower-cased; null when absent or not a plain identifier. */
export function normalizeErrorCode(raw: unknown): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return null;
  const code = value.trim().toLowerCase();
  return /^[a-z0-9_.:-]{1,64}$/.test(code) ? code : null;
}

/**
 * The title and text for a sign-in error, or null when there is no (valid) code. `guildName` is
 * DISCORD_GUILD_NAME ("the guild" when unset).
 */
export function loginErrorMessage(raw: unknown, guildName: string): LoginErrorMessage | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const code = normalizeErrorCode(raw);
  switch (code) {
    case 'not_guild_member':
      return {
        title: 'Not a member',
        message: `You're not a member of ${guildName}. Join the Discord server, then try again.`,
      };
    case 'missing_role':
      return {
        title: 'No access role',
        message: `You're in ${guildName} but don't have a role that gives access. Ask an admin.`,
      };
    case 'discord_unavailable':
      return {
        title: "Couldn't reach Discord",
        message: "We couldn't reach Discord to check your membership. Try again in a minute.",
      };
    case 'access_revoked':
      return { title: 'Access removed', message: 'An admin removed your access.' };
    case 'access_denied':
      return {
        title: 'Sign-in cancelled',
        message: 'Discord sign-in was cancelled. Press the button to try again.',
      };
    default:
      return {
        title: 'Sign-in failed',
        message: `Sign-in failed (${code ?? 'unknown_error'}). Try again, and ask an admin if it keeps happening.`,
      };
  }
}

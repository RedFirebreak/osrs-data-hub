/**
 * An account named in a tool call (D-134): a public id, or a display name matched the way the game
 * matches names (normalizeName), against the accounts the key can see (apiListAccounts). An exact
 * name wins; otherwise a name that contains the text, when exactly one does. Several matches are an
 * error listing them, so the model can ask which one was meant.
 */
import { normalizeName } from '@hub/core';
import type { DbOrTx } from '@hub/db';
import { apiListAccounts, isPublicIdLike, type ApiPrincipal } from '@hub/server';

export interface ResolvedAccount {
  id: string;
  name: string;
}

/** A tool call the hub can't answer as asked; the message tells the model why and what to do instead. */
export class ToolError extends Error {
  override name = 'ToolError';
}

/** Longest account reference a tool accepts. */
const MAX_REF_LENGTH = 64;

export async function resolveAccount(
  db: DbOrTx,
  principal: ApiPrincipal,
  ref: string,
): Promise<ResolvedAccount> {
  return (await resolveAccounts(db, principal, [ref]))[0]!;
}

/** Several references, in order; the first that can't be resolved is the error. */
export async function resolveAccounts(
  db: DbOrTx,
  principal: ApiPrincipal,
  refs: readonly string[],
): Promise<ResolvedAccount[]> {
  const visible = (await apiListAccounts(db, principal)).map((a) => ({
    id: a.id,
    name: a.name,
    key: normalizeName(a.name),
  }));
  return refs.map((raw) => {
    const ref = raw.trim().slice(0, MAX_REF_LENGTH);
    if (ref === '') throw new ToolError('An account is needed: give its name or id.');
    if (isPublicIdLike(ref)) {
      const byId = visible.find((a) => a.id === ref);
      if (byId) return { id: byId.id, name: byId.name };
    }
    const key = normalizeName(ref);
    const exact = visible.filter((a) => a.key === key);
    const matches = exact.length > 0 ? exact : visible.filter((a) => a.key.includes(key));
    if (matches.length === 1) return { id: matches[0]!.id, name: matches[0]!.name };
    if (matches.length === 0) {
      throw new ToolError(
        `No account named "${ref}" that this key can see. list_accounts (or the hub://accounts resource) lists the ones it can.`,
      );
    }
    throw new ToolError(
      `"${ref}" matches several accounts: ${matches
        .slice(0, 10)
        .map((a) => a.name)
        .join(', ')}. Ask which one is meant, and pass its exact name.`,
    );
  });
}

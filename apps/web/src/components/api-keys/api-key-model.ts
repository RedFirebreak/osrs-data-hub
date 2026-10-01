/**
 * Pure helpers for the API keys page (handoff §13, D-69, D-76): display texts, the create form's
 * state, validation and request body, and how a failed create or revoke is told. No React, no
 * browser APIs; unit-tested in api-key-model.test.ts.
 *
 * Only `import type` from @hub/server: the page's client components import this module (NEXT-12).
 * The server's limits (name length, active keys) reach the client as props from the page.
 */
import { CATEGORIES, DAY_MS, HOUR_MS, relativeTime, type Category } from '@hub/core';
import type { ApiKeyInfo, ApiKeyStatus } from '@hub/server';
import type { FailureOptions } from '@/lib/api-client';

/** How a key is shown: its prefix only; the secret is never stored in a readable form. */
export function maskedKey(prefix: string): string {
  return `ohub_${prefix}_…`;
}

export const KEY_STATUS_LABELS: Readonly<Record<ApiKeyStatus, string>> = {
  active: 'Active',
  expired: 'Expired',
  revoked: 'Revoked',
};

/** Shown for an account of a key's list that its creator can no longer see (its name is withheld). */
export const HIDDEN_ACCOUNT_LABEL = 'An account you can no longer see';

/** One-line description of a key's account scope. */
export function scopeText(
  info: Pick<ApiKeyInfo, 'accountScope' | 'accounts'> & { kind?: ApiKeyInfo['kind'] },
): string {
  if (info.kind === 'service') return 'Every account shared with the guild, now and later';
  if (info.accountScope === 'all_visible') return 'Every account you can see, now and later';
  const count = info.accounts?.length ?? 0;
  if (count === 0) return 'No accounts: the ones it listed no longer exist';
  return count === 1 ? '1 account' : `${count} accounts`;
}

/**
 * When a key expires, relative to `now`: "Never", "in 3 days", "in 5 h", "today" (under an hour),
 * or "Expired 2 d ago" once past (relativeTime).
 */
export function expiryText(expiresAt: string | null, now: string | Date): string {
  if (expiresAt === null) return 'Never';
  const at = new Date(expiresAt).getTime();
  const current = new Date(now).getTime();
  if (!Number.isFinite(at) || !Number.isFinite(current)) return 'Unknown';
  const left = at - current;
  if (left <= 0) return `Expired ${relativeTime(new Date(at), new Date(current))}`;
  if (left >= DAY_MS) {
    // Rounded: a key created "for 30 days" says "in 30 days", not 29 days and 23 hours.
    const days = Math.round(left / DAY_MS);
    return days === 1 ? 'in 1 day' : `in ${days} days`;
  }
  const hours = Math.floor(left / HOUR_MS);
  return hours >= 1 ? `in ${hours} h` : 'within the hour';
}

/** The expiry choices of the create dialog (days; null = never). */
export const EXPIRY_OPTIONS: readonly { value: string; label: string; days: number | null }[] = [
  { value: 'never', label: 'Never', days: null },
  { value: '30', label: '30 days', days: 30 },
  { value: '90', label: '90 days', days: 90 },
  { value: '365', label: '365 days', days: 365 },
];

export interface CreateKeyForm {
  name: string;
  categories: Category[];
  scope: 'all_visible' | 'list';
  accountPublicIds: string[];
  /** An EXPIRY_OPTIONS value. */
  expiry: string;
}

/** The empty form: nothing preselected, the user chooses the categories (D-76). */
export function emptyCreateForm(): CreateKeyForm {
  return { name: '', categories: [], scope: 'all_visible', accountPublicIds: [], expiry: 'never' };
}

export type CreateKeyField = 'name' | 'categories' | 'accountPublicIds' | 'expiresInDays';
export type CreateKeyErrors = Partial<Record<CreateKeyField, string>>;

/**
 * What is wrong with a key's name, or undefined: it must not be empty and not longer than `nameMax`,
 * counted as the server counts (control characters become spaces, then trimmed, in code points).
 * `example` is the name the hint suggests ("Home Assistant"). Shared by user and service keys.
 */
export function keyNameError(name: string, nameMax: number, example: string): string | undefined {
  const cleaned = name.replace(/\p{Cc}/gu, ' ').trim();
  if (cleaned.length === 0) return `Give the key a name, e.g. "${example}".`;
  if (Array.from(cleaned).length > nameMax) return `At most ${nameMax} characters.`;
  return undefined;
}

/** The days of an EXPIRY_OPTIONS value; null for "never" (and for a value that isn't an option). */
export function expiryDays(expiry: string): number | null {
  return EXPIRY_OPTIONS.find((o) => o.value === expiry)?.days ?? null;
}

/** Client-side checks before sending (the server checks everything again). */
export function validateCreateForm(form: CreateKeyForm, nameMax: number): CreateKeyErrors {
  const errors: CreateKeyErrors = {};
  const name = keyNameError(form.name, nameMax, 'Home Assistant');
  if (name) errors.name = name;
  if (form.categories.length === 0) errors.categories = 'Choose at least one category.';
  if (form.scope === 'list' && form.accountPublicIds.length === 0) {
    errors.accountPublicIds = 'Choose at least one account.';
  }
  return errors;
}

/** The POST /api/app/api-keys body for a valid form (CreateApiKeySchema's input). */
export function createKeyBody(form: CreateKeyForm): Record<string, unknown> {
  return {
    name: form.name.trim(),
    categories: CATEGORIES.filter((c) => form.categories.includes(c)),
    accountScope: form.scope,
    ...(form.scope === 'list' ? { accountPublicIds: form.accountPublicIds } : {}),
    expiresInDays: expiryDays(form.expiry),
  };
}

/** The form's fields the server's 400 `details` can name (fieldErrorsFrom, lib/api-client.ts). */
export const CREATE_KEY_FIELDS: readonly CreateKeyField[] = [
  'name',
  'categories',
  'accountPublicIds',
  'expiresInDays',
];

/** How a failed POST /api/app/api-keys is told (failureMessage, lib/api-client.ts). */
export const CREATE_KEY_FAILURE: FailureOptions = {
  fallback: "Couldn't create the key. Try again in a moment.",
  conflict: 'You have the most active keys allowed. Revoke one first.',
};

/**
 * How a failed DELETE /api/app/api-keys/[id] is told. A key that no longer exists was revoked
 * elsewhere: the page is refreshed, so it leaves the active list.
 */
export const REVOKE_KEY_FAILURE: FailureOptions = {
  fallback: "Couldn't revoke the key. Try again in a moment.",
  notFound: 'This key no longer exists. Reload the page.',
  hubMessageFor: [403, 503],
  refreshOnNotFound: true,
};

/** The API path of one key. */
export function apiKeyPath(id: string): string {
  return `/api/app/api-keys/${encodeURIComponent(id)}`;
}

/** The key string from a 201 body, or null when the body isn't one. */
export function createdKeyFrom(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const key = (body as { key?: unknown }).key;
  return typeof key === 'string' && key.startsWith('ohub_') ? key : null;
}

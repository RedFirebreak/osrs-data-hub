/**
 * The "Delete my data" card's model, kept free of React (unit-tested) and of @hub/server values
 * (a client component must not pull the server package into the browser, D-67): the confirmation
 * check, where the browser goes after a deletion, and the error text for a failed request.
 */
import { failureMessage } from '@/lib/api-client';

/** The word to type, as the server compares it (SELF_DELETE_CONFIRMATION, trimmed, any case). */
export const CONFIRMATION_WORD = 'delete';

/** Whether the typed text confirms the deletion; the server checks the same rule again. */
export function confirmsDeletion(typed: string): boolean {
  return typed.trim().toLowerCase() === CONFIRMATION_WORD;
}

/** The login page that says when the data will be deleted (see the login page's deleted notice). */
export function deletedLoginPath(graceUntil: string): string {
  return `/login?deleted=${encodeURIComponent(graceUntil)}`;
}

/** The ISO time in a 200 `{ graceUntil }`, or null when the body isn't one. */
export function graceUntilFrom(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const value = (body as { graceUntil?: unknown }).graceUntil;
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
}

/**
 * What to tell the user when POST /api/app/me/delete didn't succeed: the hub's reason for a refusal
 * (400), plain words otherwise.
 */
export function deleteErrorMessage(status: number, body: unknown): string {
  if (status === 503) return 'The hub is busy. Try again in a moment.';
  return failureMessage(status, body, {
    fallback: "Couldn't delete your data. Try again in a moment.",
    hubMessageFor: [400],
  });
}

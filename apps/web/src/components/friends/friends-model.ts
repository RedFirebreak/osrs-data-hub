/**
 * Invite a friend (D-117) on the member's Friends page: where the requests go and how a failure is
 * told. Client-safe.
 */
import type { FailureOptions } from '@/lib/api-client';

export const FRIENDS_API_PATH = '/api/app/friends';

export function friendPath(id: string): string {
  return `${FRIENDS_API_PATH}/${encodeURIComponent(id)}`;
}

/** The hub's own message says what was wrong with the name (400, 403, 409). */
export const INVITE_FAILURE: FailureOptions = {
  fallback: "Couldn't send the invite. Try again in a moment.",
  hubMessageFor: [400, 403, 409, 503],
};

export const REMOVE_FRIEND_FAILURE: FailureOptions = {
  fallback: "Couldn't remove your friend. Try again in a moment.",
  notFound: 'This friend is no longer on your list. Reload the page.',
  hubMessageFor: [403, 503],
  refreshOnNotFound: true,
};

/** "2 of 3 places left" style counts. */
export function placesLeft(used: number, max: number): string {
  const left = Math.max(0, max - used);
  return left === 0
    ? `All ${max} ${max === 1 ? 'place' : 'places'} taken`
    : `${left} of ${max} ${max === 1 ? 'place' : 'places'} left`;
}

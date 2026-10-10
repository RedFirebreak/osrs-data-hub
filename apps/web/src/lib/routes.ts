/**
 * The addresses of a character's progress pages, built in one place (typedRoutes: a string built at
 * run time needs the `Route` cast). The character page itself is `accountHref`
 * (components/accounts/account-link.tsx). Pure, server- and client-safe.
 */
import type { Route } from 'next';

const part = encodeURIComponent;

/** A character's progress: everything, over a range. */
export function progressHref(publicId: string): Route {
  return `/accounts/${part(publicId)}/metrics` as Route;
}

/** One skill's progress ("Firemaking"). */
export function skillHref(publicId: string, skill: string): Route {
  return `/accounts/${part(publicId)}/metrics?skills=${part(skill)}` as Route;
}

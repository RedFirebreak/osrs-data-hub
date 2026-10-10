/**
 * The addresses of a character's progress pages, built in one place (typedRoutes: a string built at
 * run time needs the `Route` cast). The character page itself is `accountHref`
 * (components/accounts/account-link.tsx). Pure, server- and client-safe.
 *
 *   /progress/<id>                      everything, over a range
 *   /progress/<id>/skills/<skill>       one skill ("firemaking")
 *   /progress/<id>/bosses/<activity>    one boss ("Zulrah")
 *   /progress/<id>/deep-dive            the detailed charts and their filters (D-106)
 */
import type { Route } from 'next';

const part = encodeURIComponent;

/** `?search` when there is one. */
function withSearch(path: string, search = ''): Route {
  return (search ? `${path}?${search}` : path) as Route;
}

/** A character's progress. `search` is a query string without "?" (progressSearch). */
export function progressHref(publicId: string, search?: string): Route {
  return withSearch(`/progress/${part(publicId)}`, search);
}

/** The slug of a skill in an address: "Firemaking" → "firemaking". */
export function skillSlug(skill: string): string {
  return skill.trim().toLowerCase();
}

/** One skill's progress. */
export function skillHref(publicId: string, skill: string, search?: string): Route {
  return withSearch(`/progress/${part(publicId)}/skills/${part(skillSlug(skill))}`, search);
}

/** One boss's page. `search` is a Metrics query string (metricsSearch): the boss page has a range. */
export function bossHref(publicId: string, activity: string, search?: string): Route {
  return withSearch(`/progress/${part(publicId)}/bosses/${part(activity)}`, search);
}

/** The detailed charts. `search` is a Metrics query string (metricsSearch). */
export function deepDiveHref(publicId: string, search?: string): Route {
  return withSearch(`/progress/${part(publicId)}/deep-dive`, search);
}

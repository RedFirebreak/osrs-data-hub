/**
 * The addresses of a character's progress pages, built in one place (typedRoutes: a string built at
 * run time needs the `Route` cast). The character page itself is `accountHref`
 * (components/accounts/account-link.tsx). Pure, server- and client-safe.
 *
 *   /progress/<id>                      everything, over a range
 *   /progress/<id>/skills/<skill>       one skill ("firemaking")
 *   /progress/<id>/bosses/<activity>    one boss ("Zulrah")
 *   /progress/<id>/deep-dive            the detailed charts and their filters (D-106)
 *   /accounts/<id>/collection-log       the collection log (D-118)
 *   /guild/collection-log?q=            the guild board and the lookup
 *   /settings?account=<id>#sharing      a character's sharing settings (D-122)
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

/**
 * The deep dive of one local day (YYYY-MM-DD in the viewer's time zone): a custom range of that day
 * alone: its totals on top, then its sessions. What the playtime card's bars open (D-122).
 */
export function deepDiveDayHref(publicId: string, day: string): Route {
  return deepDiveHref(publicId, `range=custom&from=${part(day)}&to=${part(day)}`);
}

/** A character's sharing settings, on the settings page (D-122). */
export function sharingHref(publicId: string): Route {
  return `/settings?account=${part(publicId)}#sharing` as Route;
}

/** A character's collection log (D-118). Not a progress page: it is what the log holds now. */
export function collectionLogHref(publicId: string): Route {
  return `/accounts/${part(publicId)}/collection-log` as Route;
}

/** The guild's collection log, with `?q=` the lookup "who has X". */
export function guildCollectionLogHref(query?: string): Route {
  return withSearch('/guild/collection-log', query ? `q=${part(query)}` : '');
}

/**
 * Public API metrics (hub_api_*, D-84). The `group` label is the first path segment after /api/v1
 * when it names one of the API's route groups, else 'unknown': the path is client-controlled, and
 * account ids never become a label (D-53).
 */
import { API_ROUTE_GROUPS, getMetrics, type ApiRouteGroup } from '@hub/server';

const GROUPS: ReadonlySet<string> = new Set(API_ROUTE_GROUPS);

/** The route group of an /api/v1 URL: `/api/v1/accounts/abc/xp` → 'accounts'. */
export function apiRouteGroup(url: string): ApiRouteGroup {
  const segment = /^\/api\/v1\/([^/?#]+)/.exec(new URL(url, 'http://x').pathname)?.[1];
  if (segment === 'openapi.json') return 'openapi';
  return segment !== undefined && GROUPS.has(segment) ? (segment as ApiRouteGroup) : 'unknown';
}

/**
 * Starts timing one API request; the returned function counts it with the response's status in
 * hub_api_requests_total and its duration in hub_api_request_duration_seconds, and returns the
 * response unchanged.
 */
export function measureApiRequest(group: ApiRouteGroup): (res: Response) => Response {
  const stopTimer = getMetrics().apiLatency.startTimer({ group });
  return (res) => {
    stopTimer();
    getMetrics().apiRequests.inc({ group, status: String(res.status) });
    return res;
  };
}

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { metricsAccess, type HubMetrics } from '@hub/server';

type Registry = HubMetrics['registry'];

/**
 * The worker's Prometheus endpoint (D-84): `GET /metrics` on WORKER_METRICS_PORT, with the web
 * route's rules (metricsAccess): 404 without METRICS_TOKEN, 401 without `Authorization: Bearer
 * <METRICS_TOKEN>`, else the worker's registry. Any other path is 404, any other method 405. Compose
 * publishes the port on 127.0.0.1 only (WORKER_METRICS_BIND to widen it); the proxy never sees it.
 */
export function createMetricsServer(opts: {
  registry: Registry;
  token: string | undefined;
}): Server {
  return createServer((req, res) => {
    void handle(opts, req, res).catch(() => {
      if (!res.headersSent) send(res, 500, 'Internal Server Error');
      else res.destroy();
    });
  });
}

async function handle(
  opts: { registry: Registry; token: string | undefined },
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  // Only the path: req.url is origin-form ("/metrics?x"); the host part is never read.
  const path = (req.url ?? '/').split('?', 1)[0];
  if (path !== '/metrics') return send(res, 404, 'Not Found');
  const access = metricsAccess(req.headers.authorization, opts.token);
  if (access === 'disabled') return send(res, 404, 'Not Found');
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, 'Method Not Allowed', { allow: 'GET, HEAD' });
  }
  if (access === 'unauthorized') {
    return send(res, 401, 'Unauthorized', { 'www-authenticate': 'Bearer realm="metrics"' });
  }
  const body = await opts.registry.metrics();
  res.writeHead(200, { 'content-type': opts.registry.contentType, 'cache-control': 'no-store' });
  res.end(req.method === 'HEAD' ? undefined : body);
}

function send(
  res: ServerResponse,
  status: number,
  body: string,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(body);
}

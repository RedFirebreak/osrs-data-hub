import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createTestMetrics } from '@hub/server';
import { afterEach, describe, expect, it } from 'vitest';
import { createMetricsServer } from './metrics-server';

const TOKEN = 's3cret-metrics-token';
let server: Server | undefined;

/** Starts a server on an ephemeral port and returns its base URL. */
async function start(token: string | undefined) {
  const metrics = createTestMetrics();
  server = createMetricsServer({ registry: metrics.registry, token });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { metrics, url: `http://127.0.0.1:${port}` };
}

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

const get = (url: string, authorization?: string, method = 'GET') =>
  fetch(url, { method, headers: authorization === undefined ? {} : { authorization } });

describe('worker metrics endpoint (D-83)', () => {
  it('404 when METRICS_TOKEN is not set, token or not', async () => {
    const { url } = await start(undefined);
    expect((await get(`${url}/metrics`)).status).toBe(404);
    const res = await get(`${url}/metrics`, 'Bearer anything');
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('hub_');
  });

  it('401 without the right bearer token', async () => {
    const { url } = await start(TOKEN);
    for (const header of [
      undefined,
      '',
      TOKEN,
      `Basic ${TOKEN}`,
      'Bearer wrong',
      `Bearer ${TOKEN}-and-more`,
      `Bearer ${TOKEN.slice(0, -1)}`,
    ]) {
      const res = await get(`${url}/metrics`, header);
      expect(res.status, String(header)).toBe(401);
      expect(res.headers.get('www-authenticate')).toBe('Bearer realm="metrics"');
      expect(await res.text()).not.toContain('hub_');
    }
  });

  it('200 with the registry in Prometheus text format', async () => {
    const { metrics, url } = await start(TOKEN);
    metrics.jobRuns.inc({ job_name: 'expire-grace', result: 'success' });

    const res = await get(`${url}/metrics`, `Bearer ${TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe(metrics.registry.contentType);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toContain(
      'hub_job_runs_total{job_name="expire-grace",result="success"} 1',
    );
    // Case-insensitive scheme (RFC 7235), and a query string doesn't change the path.
    expect((await get(`${url}/metrics?x=1`, `bearer ${TOKEN}`)).status).toBe(200);
  });

  it('answers HEAD without a body', async () => {
    const { url } = await start(TOKEN);
    const res = await get(`${url}/metrics`, `Bearer ${TOKEN}`, 'HEAD');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
  });

  it('404 for any other path, 405 for any other method', async () => {
    const { url } = await start(TOKEN);
    expect((await get(`${url}/`, `Bearer ${TOKEN}`)).status).toBe(404);
    expect((await get(`${url}/metrics/x`, `Bearer ${TOKEN}`)).status).toBe(404);
    const post = await get(`${url}/metrics`, `Bearer ${TOKEN}`, 'POST');
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET, HEAD');
  });
});

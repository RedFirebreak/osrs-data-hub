import { parseConfig, setConfigForTests } from '@hub/core';
import { getMetrics } from '@hub/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET } from './route';

// connection() needs a Next request scope; the route runs bare here.
vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  connection: () => Promise.resolve(),
}));

function useConfig(env: Record<string, string> = {}) {
  setConfigForTests(parseConfig({ APP_URL: 'https://hub.example.com', ...env }));
}

const scrape = (authorization?: string) =>
  GET(
    new Request('http://0.0.0.0:3000/metrics', {
      headers: authorization === undefined ? {} : { authorization },
    }),
  );

afterEach(() => setConfigForTests(undefined));

describe('GET /metrics', () => {
  it('404 when METRICS_TOKEN is not set', async () => {
    useConfig();
    const res = await scrape('Bearer anything');
    expect(res.status).toBe(404);
  });

  it('401 without the right bearer token', async () => {
    useConfig({ METRICS_TOKEN: 's3cret-metrics-token' });
    for (const header of [
      undefined,
      '',
      's3cret-metrics-token',
      'Basic s3cret-metrics-token',
      'Bearer wrong',
      'Bearer s3cret-metrics-token-and-more',
      'Bearer s3cret-metrics-toke',
    ]) {
      const res = await scrape(header);
      expect(res.status, String(header)).toBe(401);
      expect(await res.text()).not.toContain('hub_');
    }
  });

  it('200 with the registry in Prometheus text format', async () => {
    useConfig({ METRICS_TOKEN: 's3cret-metrics-token' });
    getMetrics().pairAttempts.inc({ result: 'paired' });
    const res = await scrape('Bearer s3cret-metrics-token');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe(getMetrics().registry.contentType);
    const body = await res.text();
    expect(body).toContain('hub_pair_attempts_total{result="paired"}');
    expect(body).toContain('hub_ingest_payloads_total');
    // Case-insensitive scheme, as RFC 7235 allows.
    expect((await scrape('bearer s3cret-metrics-token')).status).toBe(200);
  });
});

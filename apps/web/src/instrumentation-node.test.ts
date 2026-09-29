import { setConfigForTests } from '@hub/core';
import { silentLogger } from '@hub/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startNode } from './instrumentation-node';

beforeEach(() => {
  (globalThis as { __hubLogger?: unknown }).__hubLogger = silentLogger();
  setConfigForTests(undefined);
  vi.stubEnv('DATABASE_URL', '');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  setConfigForTests(undefined);
});

describe('startNode', () => {
  it('exits(1) in production when APP_URL has a path (D-26), naming the variable', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('APP_URL', 'https://hub.example.com/hub');
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    startNode();
    expect(exit).toHaveBeenCalledWith(1);
    expect(String(stderr.mock.calls[0]?.[0])).toContain('APP_URL');
  });

  it('only logs outside production', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('APP_URL', 'not a url');
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    startNode();
    expect(exit).not.toHaveBeenCalled();
  });

  it('does nothing during next build', () => {
    vi.stubEnv('NEXT_PHASE', 'phase-production-build');
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('APP_URL', 'https://hub.example.com/hub');
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    startNode();
    expect(exit).not.toHaveBeenCalled();
  });

  it('starts nothing without DATABASE_URL and does not throw on a valid config', () => {
    vi.stubEnv('APP_URL', 'https://hub.example.com');
    expect(() => startNode()).not.toThrow();
  });
});

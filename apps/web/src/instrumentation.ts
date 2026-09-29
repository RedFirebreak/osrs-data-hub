/**
 * Next.js instrumentation: `register()` runs once per server start, before the first request. This
 * file is also compiled for the Edge runtime, so it holds no Node APIs; the Node part is imported
 * dynamically behind NEXT_RUNTIME (NEXT-3).
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startNode } = await import('./instrumentation-node');
    startNode();
  }
}

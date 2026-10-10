import path from 'node:path';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  // Monorepo root so standalone tracing includes the workspace packages (Next sets turbopack.root to
  // the same value).
  outputFileTracingRoot: path.join(import.meta.dirname, '../..'),
  typedRoutes: true,
  // `next dev` writes AGENTS.md/CLAUDE.md into the app when it detects an AI agent; opt out.
  agentRules: false,
  // Never redirect plugin endpoints: the plugin turns a 301/302 into a body-less GET and does not
  // follow 307/308 (see PLUGIN-2). Keep the default (no trailing slash redirects added by us).
  trailingSlash: false,
  poweredByHeader: false,
  // Pages only (never a plugin endpoint, see above): the Metrics tab moved under /progress (D-112).
  // A bookmarked or shared view keeps opening, with its query.
  redirects() {
    return Promise.resolve([
      {
        source: '/accounts/:publicId/metrics',
        destination: '/progress/:publicId/deep-dive',
        permanent: true,
      },
      {
        source: '/accounts/:publicId/metrics/bosses/:activity',
        destination: '/progress/:publicId/bosses/:activity',
        permanent: true,
      },
    ]);
  },
};

export default nextConfig;

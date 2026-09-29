/**
 * /docs/api (D-75): the interactive reference of API v1, public (outside the signed-in (app) group),
 * rendered by Scalar from /api/v1/openapi.json. A thin bar links back to the hub and to the raw
 * document, which is also what the page offers without JavaScript.
 */
import { getConfig } from '@hub/core';
import type { Metadata } from 'next';
import Link from 'next/link';
import { connection } from 'next/server';
import { HubMark } from '@/components/shell/hub-mark';
import { ScalarReference } from './scalar-reference';

const SPEC_URL = '/api/v1/openapi.json';

export function generateMetadata(): Metadata {
  return { title: `API reference · ${getConfig().hubName}` };
}

export default async function ApiDocsPage() {
  // The hub name comes from the environment at run time, not at build time.
  await connection();
  const { hubName } = getConfig();
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm sm:px-6">
          <Link href="/" className="flex items-center gap-2 font-semibold">
            <HubMark className="size-6" />
            {hubName}
          </Link>
          <nav aria-label="API reference" className="flex items-center gap-4">
            <Link href="/api-keys" className="underline-offset-4 hover:underline">
              API keys
            </Link>
            <a href={SPEC_URL} className="underline-offset-4 hover:underline">
              OpenAPI JSON
            </a>
          </nav>
        </div>
      </header>
      <main id="main" className="flex-1">
        <h1 className="sr-only">API reference</h1>
        <noscript>
          <p className="mx-auto max-w-2xl px-4 py-10 text-sm">
            The interactive reference needs JavaScript. The API is described in the{' '}
            <a href={SPEC_URL} className="underline underline-offset-4">
              OpenAPI document
            </a>
            .
          </p>
        </noscript>
        <ScalarReference specUrl={SPEC_URL} />
      </main>
    </div>
  );
}

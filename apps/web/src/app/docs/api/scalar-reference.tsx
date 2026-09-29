'use client';
/**
 * Scalar's interactive API reference (D-75), loaded from jsDelivr at a pinned version with Subresource
 * Integrity (the hash of that exact file, which is byte-identical to the npm tarball's), mounted on a
 * div once the script is ready, with telemetry, Scalar's hosted fonts, its AI agent and MCP helpers
 * switched off (scalar.ts). Without JavaScript, or when the CDN is unreachable or the file doesn't
 * match its hash, the page still links to the raw OpenAPI document.
 */
import Script from 'next/script';
import { useRef, useState } from 'react';
import { SCALAR_CONFIG, SCALAR_INTEGRITY, SCALAR_SRC } from './scalar';

interface ScalarGlobal {
  createApiReference: (target: Element, config: Record<string, unknown>) => unknown;
}

export function ScalarReference({ specUrl }: { specUrl: string }) {
  const target = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);

  function mount(): void {
    const scalar = (window as unknown as { Scalar?: ScalarGlobal }).Scalar;
    const el = target.current;
    if (!scalar || !el || el.childElementCount > 0) return;
    scalar.createApiReference(el, { ...SCALAR_CONFIG, url: specUrl });
  }

  return (
    <>
      {failed && (
        <p role="alert" className="mx-auto max-w-2xl px-4 py-10 text-sm text-muted-foreground">
          The interactive reference couldn’t be loaded. The API is described in the{' '}
          <a href={specUrl} className="underline underline-offset-4">
            OpenAPI document
          </a>
          .
        </p>
      )}
      <div ref={target} />
      <Script
        src={SCALAR_SRC}
        integrity={SCALAR_INTEGRITY}
        crossOrigin="anonymous"
        strategy="afterInteractive"
        onReady={mount}
        onError={() => setFailed(true)}
      />
    </>
  );
}

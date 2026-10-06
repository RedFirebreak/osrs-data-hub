/**
 * The favicon, app/icon.svg (Next's file convention: served as /icon.svg and linked from every
 * page). It lies at the root of app/, outside the (app) group whose layout asks for a session, so
 * the sign-in page gets it too; the app has no middleware or proxy in front of its routes.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HubMark } from '@/components/shell/hub-mark';

const icon = () => readFileSync(path.join(import.meta.dirname, 'icon.svg'), 'utf8');

describe('favicon', () => {
  it('is a standalone SVG image', () => {
    const svg = icon();
    // Without the namespace a browser takes an .svg file for plain XML and draws nothing.
    expect(svg).toMatch(/^<svg\b[^>]*\bxmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    expect(svg).toMatch(/^<svg\b[^>]*\bviewBox="0 0 \d+ \d+"/);
    expect(svg.trimEnd()).toMatch(/<\/svg>$/);
  });

  it("is the header's mark: the pulse line of HubMark on a rounded square", () => {
    const svg = icon();
    const line = /<path d="([^"]+)"/.exec(renderToStaticMarkup(<HubMark />))?.[1];
    expect(line).toBeDefined();
    expect(svg).toContain(` d="${line}"`);
    expect(svg).toMatch(/<rect\b[^>]*\brx="\d+"/);
  });
});

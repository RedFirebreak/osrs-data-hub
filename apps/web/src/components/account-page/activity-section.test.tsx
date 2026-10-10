import type { PlaySession } from '@hub/server';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ActivityContent } from './activity-section';

function session(worlds: number[]): PlaySession {
  return {
    id: 's1',
    startedAt: '2026-10-09T16:51:00.000Z',
    endedAt: '2026-10-09T19:17:00.000Z',
    lastSeenAt: '2026-10-09T19:17:00.000Z',
    durationMs: 146 * 60_000,
    worlds,
    endReason: 'logout',
  };
}

function render(worlds: number[]): string {
  const html = renderToStaticMarkup(
    <ActivityContent sessions={[session(worlds)]} playtime={[]} timezone="UTC" />,
  );
  // Text-node separators React adds between adjacent strings ("World<!-- -->302").
  return html.replace(/<!-- -->/g, '');
}

describe('ActivityContent, recent sessions', () => {
  it('names a single world, and a few in full', () => {
    expect(render([395])).toContain('World 395');
    const html = render([395, 394, 390]);
    expect(html).toContain('Worlds 395, 394, 390');
    expect(html).not.toContain('more');
  });

  it('collapses a world hopper to three worlds and "and N more", the rest behind it', () => {
    const worlds = Array.from({ length: 44 }, (_, i) => 300 + i);
    const html = render(worlds);
    expect(html).toContain('Worlds 300, 301, 302');
    expect(html).toContain('and 41 more</summary>');
    expect(html).toContain(', 303, 304');
    expect(html).toContain('343');
  });
});

import type { OnlineEntry } from '@hub/server';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { OnlineNow } from './online-now';

const entry: OnlineEntry = {
  publicId: 'AbCdEf123456',
  name: 'Zezima',
  accountType: 1,
  world: 302,
  specialWorld: true,
  lastSeen: '2026-09-29T10:00:00.000Z',
};

describe('OnlineNow', () => {
  it('lists the server-rendered accounts with world and account page link', () => {
    const html = renderToStaticMarkup(<OnlineNow initial={[entry]} />);
    expect(html).toContain('href="/accounts/AbCdEf123456"');
    expect(html).toContain('World 302 (special world)');
    expect(html).toContain('1 online');
  });

  it('tells the viewer nobody is online', () => {
    expect(renderToStaticMarkup(<OnlineNow initial={[]} />)).toContain('Nobody in the guild');
  });

  it('labels each strip by its own heading (usable twice on one page)', () => {
    const html = renderToStaticMarkup(
      <>
        <OnlineNow initial={[entry]} />
        <OnlineNow initial={[]} />
      </>,
    );
    const labelledBy = [...html.matchAll(/aria-labelledby="([^"]+)"/g)].map((m) => m[1]);
    expect(labelledBy).toHaveLength(2);
    expect(new Set(labelledBy).size).toBe(2);
    for (const id of labelledBy) expect(html).toContain(`<h2 id="${id}"`);
  });
});

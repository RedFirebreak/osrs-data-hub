import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ItemTile } from '@/components/account-page/item-tile';
import { SkillsPanel } from '@/components/account-page/skills-panel';
import { EventFeed } from '@/components/events/event-feed';
import { feedEvent } from '@/components/live/test-fixtures';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { IconConfig } from '@/lib/osrs-icons';
import { IconConfigLoader, IconConfigProvider } from './icon-config-provider';

const BASE = 'http://localhost:8765';
const ICONS: IconConfig = {
  base: BASE,
  stacks: {
    995: [
      [2, 996],
      [250, 1002],
      [10000, 1004],
    ],
  },
};

function render(node: React.ReactNode, icons: IconConfig | null = ICONS): string {
  const tree = <TooltipProvider>{node}</TooltipProvider>;
  return renderToStaticMarkup(
    icons ? <IconConfigProvider value={icons}>{tree}</IconConfigProvider> : tree,
  );
}

const coins = { id: 995, name: 'Coins', quantity: 250, gePrice: 1 };

describe('ItemTile with icons', () => {
  it('shows the stack picture for the quantity, the stack label, and keeps the name accessible', () => {
    const html = render(<ItemTile item={coins} />);
    expect(html).toContain(`src="${BASE}/items/1002.webp"`);
    expect(html).toContain('alt=""');
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('>250</span>');
    expect(html).toContain('title="250 × Coins, 250 gp"');
    expect(html).toContain('<span class="sr-only">250 × Coins, 250 gp</span>');
    // The visible name is the fallback only.
    expect(html).not.toContain('line-clamp-2');
  });

  it('shows the name instead when icons are off', () => {
    const html = render(<ItemTile item={coins} />, null);
    expect(html).not.toContain('<img');
    expect(html).toContain('line-clamp-2');
    expect(render(<ItemTile item={coins} />, { base: null, stacks: {} })).not.toContain('<img');
  });

  it('holds a stacked quantity back while the browser loads the stack tables', () => {
    const loading = (node: React.ReactNode) =>
      renderToStaticMarkup(<IconConfigLoader base={BASE}>{node}</IconConfigLoader>);
    const pending = loading(<ItemTile item={coins} />);
    expect(pending).not.toContain('<img');
    expect(pending).not.toContain('line-clamp-2');
    expect(loading(<ItemTile item={{ ...coins, id: 4151, quantity: 1 }} />)).toContain(
      `src="${BASE}/items/4151.webp"`,
    );
    expect(
      renderToStaticMarkup(
        <IconConfigLoader base={null}>{<ItemTile item={coins} />}</IconConfigLoader>,
      ),
    ).toContain('line-clamp-2');
  });

  it('shows an empty equipment slot as its silhouette, the label kept for screen readers', () => {
    const html = render(<ItemTile item={null} placeholder="Neck" slot="AMULET" />);
    expect(html).toContain(`src="${BASE}/slots/amulet.png"`);
    expect(html).toContain('<span class="sr-only">Neck: empty</span>');
    expect(render(<ItemTile item={null} placeholder="Neck" slot="AMULET" />, null)).toContain(
      '<span aria-hidden="true">Neck</span>',
    );
  });
});

describe('game icons elsewhere', () => {
  it('puts skill icons on skill tiles, and gives Overall no tile', () => {
    const gains = { day: 0, week: 0, month: 0, year: 0 };
    const html = render(
      <SkillsPanel
        publicId="abc123def456"
        rows={[
          { skill: 'Overall', level: 2000, realLevel: 2000, xp: 1, gains },
          { skill: 'Attack', level: 99, realLevel: 99, xp: 1, gains },
        ]}
      />,
    );
    expect(html).toContain(`src="${BASE}/skills/attack.png"`);
    expect(html).not.toContain('overall.png');
  });

  it("uses an event's item icon, and the lucide icon when it has none", () => {
    const html = render(
      <EventFeed
        events={[feedEvent({ itemId: 13576 }), feedEvent({ id: 'b', seq: 2, itemId: null })]}
        now="2026-09-29T10:00:00.000Z"
      />,
    );
    expect(html).toContain(`src="${BASE}/items/13576.webp"`);
    expect(html).toContain('lucide');
  });
});

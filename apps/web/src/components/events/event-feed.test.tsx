import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { feedEvent } from '@/components/live/test-fixtures';
import { TooltipProvider } from '@/components/ui/tooltip';
import { EventFeed, lootValue, valueTone } from './event-feed';
import { eventIconFor } from './event-icon';

function render(node: React.ReactNode): string {
  return renderToStaticMarkup(<TooltipProvider>{node}</TooltipProvider>);
}

describe('EventFeed', () => {
  const loot = feedEvent();
  const death = feedEvent({
    id: 'death-1',
    seq: 11,
    type: 'death',
    valueGp: 34_900,
    icon: 'skull',
    title: 'Death',
    line: 'Zezima died (inventory value lost: 34.9K)',
    occurredAt: '2026-09-29T09:00:00.000Z',
    specialWorld: true,
  });

  it('renders lines, relative times against the server render time, and loot values', () => {
    const html = render(<EventFeed events={[loot, death]} now="2026-09-29T10:03:30.000Z" />);
    expect(html).toContain('Zezima received Dragon warhammer (38.2M) from Lizardman shaman');
    expect(html).toContain('href="/accounts/AbCdEf123456"');
    expect(html).toContain('<time dateTime="2026-09-29T10:00:00.000Z"');
    expect(html).toContain('3 min ago');
    expect(html).toContain('1 h ago');
    expect(html).toContain('38.2M gp');
    // A death's value is in its line, not badged; its special world is.
    expect(html).not.toContain('34.9K gp');
    expect(html).toContain('Special world');
    expect(html).toContain('<span class="sr-only">Loot</span>');
  });

  it('can leave lines unlinked and shows the empty state', () => {
    const html = render(
      <EventFeed events={[loot]} now="2026-09-29T10:00:00.000Z" linkAccounts={false} />,
    );
    expect(html).not.toContain('href=');
    expect(render(<EventFeed events={[]} />)).toContain('No events yet.');
    expect(render(<EventFeed events={[]} empty={<p>Nothing here</p>} />)).toBe(
      '<p>Nothing here</p>',
    );
  });
});

describe('event helpers', () => {
  it('badges loot values only', () => {
    expect(lootValue({ type: 'loot', valueGp: 5 })).toBe(5);
    expect(lootValue({ type: 'pk_loot', valueGp: 1_000 })).toBe(1_000);
    expect(lootValue({ type: 'loot', valueGp: 0 })).toBeNull();
    expect(lootValue({ type: 'loot', valueGp: null })).toBeNull();
    expect(lootValue({ type: 'death', valueGp: 10 })).toBeNull();
  });

  it('colours values like coin stacks', () => {
    expect(valueTone(99_999)).toContain('amber');
    expect(valueTone(100_000)).toBe('text-foreground');
    expect(valueTone(10_000_000)).toContain('emerald');
  });

  it('falls back to the bell for unknown icon hints', () => {
    expect(eventIconFor('gift')).not.toBe(eventIconFor('bell'));
    expect(eventIconFor('nope')).toBe(eventIconFor('bell'));
    expect(eventIconFor('constructor')).toBe(eventIconFor('bell'));
  });
});

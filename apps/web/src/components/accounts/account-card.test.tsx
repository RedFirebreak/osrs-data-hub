import type { AccountCard as CardData } from '@hub/server';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { feedEvent } from '@/components/live/test-fixtures';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AccountCard } from './account-card';

const NOW = '2026-09-29T10:05:00.000Z';

function card(overrides: Partial<CardData> = {}): CardData {
  return {
    publicId: 'AbCdEf123456',
    name: 'Zezima',
    accountType: 1,
    relation: 'owner',
    presence: {
      visible: true,
      shared: true,
      updatedAt: '2026-09-29T10:00:00.000Z',
      data: {
        online: true,
        world: 302,
        specialWorld: false,
        gameState: 'LOGGED_IN',
        lastSeen: '2026-09-29T10:00:00.000Z',
      },
    },
    totalLevel: 2000,
    overallXp: 123_456_789,
    gains: { today: 0, week: 1_000 },
    recentEvents: [feedEvent()],
    ...overrides,
  };
}

function render(node: React.ReactNode): string {
  return renderToStaticMarkup(<TooltipProvider>{node}</TooltipProvider>);
}

describe('AccountCard', () => {
  it("marks the account's name up as a heading (h3 under the dashboard's h2), events below it", () => {
    const html = render(<AccountCard card={card()} now={NOW} />);
    expect(html).toMatch(/<h3[^>]*><a[^>]*href="\/accounts\/AbCdEf123456"[^>]*>Zezima<\/a><\/h3>/);
    expect(html).toMatch(/<h4[^>]*>Recent events<\/h4>/);
    expect(html).toContain('Online');
    expect(html).toContain('World 302');
    expect(html).toContain('2,000');
    expect(html).toContain('+1,000');
  });

  it('takes the heading level from the page', () => {
    const html = render(<AccountCard card={card()} now={NOW} headingLevel={2} />);
    expect(html).toMatch(/<h2[^>]*><a[^>]*>Zezima<\/a><\/h2>/);
    expect(html).toMatch(/<h3[^>]*>Recent events<\/h3>/);
  });

  it('badges stats and presence the plugin never sent, and hides presence the viewer may not see', () => {
    const notShared = render(
      <AccountCard
        card={card({
          presence: { visible: true, shared: false },
          totalLevel: null,
          overallXp: null,
          gains: { today: null, week: null },
          recentEvents: [],
        })}
        now={NOW}
      />,
    );
    expect(notShared.match(/Not shared/g)).toHaveLength(2);
    expect(notShared).toContain('No events yet');
    const hidden = render(<AccountCard card={card({ presence: { visible: false } })} now={NOW} />);
    expect(hidden).not.toContain('Online');
    expect(hidden).not.toContain('Offline');
  });
});

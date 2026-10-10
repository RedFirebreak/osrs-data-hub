import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { feedEvent } from '@/components/live/test-fixtures';
import { TooltipProvider } from '@/components/ui/tooltip';
import { EventFeedItem, levelUpSkill } from './event-feed';

const levelUp = feedEvent({ type: 'level_up', skill: 'Firemaking', level: 87 });

describe('a level-up in the timeline', () => {
  it('names its skill when that skill has a progress page', () => {
    expect(levelUpSkill(levelUp)).toBe('Firemaking');
    // Combat is a level-up without a skill page; loot names no skill at all.
    expect(levelUpSkill({ type: 'level_up', skill: 'Combat' })).toBeNull();
    expect(levelUpSkill({ type: 'level_up', skill: null })).toBeNull();
    expect(levelUpSkill({ type: 'loot', skill: 'Firemaking' })).toBeNull();
  });

  it("opens the skill's page where the account is the page, and the account elsewhere", () => {
    const render = (linkAccount: boolean) =>
      renderToStaticMarkup(
        <TooltipProvider>
          <EventFeedItem event={levelUp} linkAccount={linkAccount} now={levelUp.occurredAt} />
        </TooltipProvider>,
      );
    const id = levelUp.account.publicId;
    expect(render(false)).toContain(`href="/progress/${id}/skills/firemaking"`);
    expect(render(true)).toContain(`href="/accounts/${id}"`);
    expect(render(true)).not.toContain('/skills/');
  });
});

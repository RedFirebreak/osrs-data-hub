import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SkillSelect, defaultSkill } from './skill-select';

describe('defaultSkill', () => {
  it('starts on Overall when it is offered, else on the first skill', () => {
    expect(defaultSkill(['Attack', 'Overall'])).toBe('Overall');
    expect(defaultSkill(['Attack', 'Magic'])).toBe('Attack');
    expect(defaultSkill([])).toBe('');
  });
});

describe('SkillSelect', () => {
  it('is a select labelled "Skill" that shows the chosen skill', () => {
    const html = renderToStaticMarkup(
      <SkillSelect
        skills={['Overall', 'Attack']}
        value="Attack"
        onChange={() => {}}
        className="flex items-center gap-2"
      />,
    );
    const id = /<label for="([^"]+)" class="sr-only">Skill<\/label>/.exec(html)?.[1];
    expect(id).toBeTruthy();
    expect(html).toMatch(/^<div class="flex items-center gap-2"><label/);
    expect(html).toMatch(new RegExp(`<button[^>]*role="combobox"[^>]*id="${id}"`));
  });
});

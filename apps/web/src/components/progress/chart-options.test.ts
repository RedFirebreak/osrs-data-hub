import { describe, expect, it } from 'vitest';
import { FALLBACK_THEME, type ChartTheme } from '@/components/charts/options';
import { headlineText } from './headline';
import { progressColor, progressOption, type ProgressChartInput } from './chart-options';

const light: ChartTheme = FALLBACK_THEME;
const dark: ChartTheme = { ...FALLBACK_THEME, dark: true, text: 'rgba(250, 250, 250, 1)' };

const input: ProgressChartInput = {
  points: [
    [0, 0],
    [3_600_000, 1_200],
    [7_200_000, 1_200],
  ],
  from: '2026-10-09T12:00:00.000Z',
  to: '2026-10-10T12:00:00.000Z',
  measure: 'xp',
  skill: 'Firemaking',
  name: 'Firemaking XP',
  timezone: 'UTC',
  animate: true,
};

describe('progressColor', () => {
  it('draws a skill in its own colour, per theme, and all XP in the text colour', () => {
    expect(progressColor('xp', 'Firemaking', light)).toBe('#a85a0b');
    expect(progressColor('xp', 'Firemaking', dark)).toBe('#f08a24');
    expect(progressColor('xp', null, dark)).toBe(dark.text);
  });

  it('gives loot, kills and play time one palette colour each', () => {
    const colors = (['gp', 'kills', 'active'] as const).map((m) => progressColor(m, null, light));
    expect(colors).toEqual([...light.series]);
    expect(new Set(colors).size).toBe(3);
  });
});

describe('progressOption', () => {
  it('draws the running total over the whole range, in the skill colour', () => {
    const option = progressOption(input, light);
    const [series] = option.series as { id: string; data: [number, number][]; color: string }[];
    const start = Date.parse(input.from);
    expect(series?.data).toEqual([
      [start, 0],
      [start + 3_600_000, 1_200],
      [start + 7_200_000, 1_200],
    ]);
    expect(series?.color).toBe('#a85a0b');
    // The axis spans the range, however little of it has data.
    expect(option.xAxis).toMatchObject({ min: start, max: Date.parse(input.to) });
  });

  it('keeps one series under one id, so a new range moves the line instead of replacing it', () => {
    const week = progressOption({ ...input, from: '2026-10-03T12:00:00.000Z' }, light);
    const day = progressOption(input, light);
    const ids = (o: typeof day) => (o.series as { id: string }[]).map((s) => s.id);
    expect(ids(week)).toEqual(['progress']);
    expect(ids(day)).toEqual(['progress']);
    expect(day.animation).toBe(true);
  });

  it('stands still for people who asked for less motion', () => {
    expect(progressOption({ ...input, animate: false }, light).animation).toBe(false);
  });
});

describe('headlineText', () => {
  it('signs a gain and writes it in the measure', () => {
    expect(headlineText('xp', 1_265_900)).toBe('+1,265,900 XP');
    expect(headlineText('gp', 4_820_000)).toBe('+4.82M gp');
    expect(headlineText('kills', 1)).toBe('+1 kill');
    expect(headlineText('xp', 0)).toBe('+0 XP');
  });

  it('writes play time as a duration, without a sign', () => {
    expect(headlineText('active', 6 * 3_600_000 + 12 * 60_000)).toBe('6h 12m');
  });
});

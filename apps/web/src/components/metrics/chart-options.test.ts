import type { HeatCell, PeriodComparison, RateStep } from '@hub/core';
import type { BossPeriod, SessionCard, SessionTimeline } from '@hub/server';
import { describe, expect, it } from 'vitest';
import { FALLBACK_THEME, SERIES_LIGHT } from '@/components/charts/options';
import {
  activityColors,
  bossKillsOption,
  bossLootOption,
  brushedSpan,
  bucketIndex,
  comparisonOption,
  dropSize,
  foldTimeByActivity,
  heatmapOption,
  hoursAxis,
  lootAgainstKills,
  otherColor,
  rateThroughOption,
  scatterOption,
  timelineOption,
} from './chart-options';
import { formatAmount, formatEtaDays, formatRate, formatSessionMinute } from './format';
import { sessionsInCell } from './metrics-charts';

const theme = FALLBACK_THEME;
type Series = {
  name?: string;
  type?: string;
  data?: unknown[];
  stack?: string;
  markArea?: unknown;
};
const seriesOf = (option: { series?: unknown }) => option.series as Series[];

function card(over: Partial<SessionCard> = {}): SessionCard {
  return {
    id: 'a',
    start: '2026-10-05T18:00:00.000Z',
    end: '2026-10-05T19:00:00.000Z',
    open: false,
    onlineMs: 3_600_000,
    activeMs: 1_800_000,
    xp: 60_000,
    xpBySkill: [{ skill: 'Ranged', xp: 60_000 }],
    gp: 0,
    drops: 0,
    kills: [],
    killsShared: false,
    main: { kind: 'skill', name: 'Ranged' },
    value: 60_000,
    ...over,
  };
}

describe('activityColors', () => {
  it('gives the first three names the categorical colours in order and everything else Other', () => {
    const color = activityColors(theme, ['Zulrah', 'Fishing'], ['Woodcutting', 'Mining']);
    expect(['Zulrah', 'Fishing', 'Woodcutting', 'Mining'].map(color)).toEqual([
      ...SERIES_LIGHT,
      otherColor(theme),
    ]);
    expect(color('Other')).toBe(otherColor(theme));
  });
});

describe('comparisonOption', () => {
  const comparison: PeriodComparison = {
    stepMs: 86_400_000,
    current: [
      [0, 0],
      [86_400_000, 500],
    ],
    previous: [
      [0, 0],
      [86_400_000, 300],
    ],
  };
  const option = comparisonOption(
    {
      comparison,
      measure: 'xp',
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-10-02T00:00:00.000Z',
      timezone: 'UTC',
    },
    theme,
  );

  it('draws this period and the one before on the range’s own time axis, with a legend', () => {
    const [current, previous] = seriesOf(option);
    const start = Date.parse('2026-10-01T00:00:00.000Z');
    expect(current?.data).toEqual([
      [start, 0],
      [start + 86_400_000, 500],
    ]);
    expect(previous?.name).toBe('Previous period');
    expect(option.legend).toBeDefined();
    expect(option.brush).toMatchObject({ brushType: 'lineX', xAxisIndex: 0 });
  });

  it('has no legend for one series', () => {
    const one = comparisonOption(
      {
        comparison: { ...comparison, previous: null },
        measure: 'gp',
        from: '2026-10-01T00:00:00.000Z',
        to: '2026-10-02T00:00:00.000Z',
        timezone: 'UTC',
      },
      theme,
    );
    expect(one.legend).toBeUndefined();
    expect(seriesOf(one)).toHaveLength(1);
  });
});

describe('brushedSpan', () => {
  it('reads the brushed x range, and ignores a cleared or tiny brush', () => {
    expect(brushedSpan({ areas: [{ coordRange: [2_000_000, 500_000] }] })).toEqual({
      from: 500_000,
      to: 2_000_000,
    });
    expect(brushedSpan({ areas: [] })).toBeNull();
    expect(brushedSpan({ areas: [{ coordRange: [0, 1000] }] })).toBeNull();
    expect(brushedSpan(null)).toBeNull();
  });
});

describe('heatmapOption', () => {
  const cells: HeatCell[] = [
    { weekday: 0, hour: 18, onlineMs: 3_600_000, activeMs: 1_800_000, value: 30_000, sessions: 1 },
    { weekday: 0, hour: 19, onlineMs: 0, activeMs: 0, value: 0, sessions: 0 },
  ];

  it('colours played cells by the rate per active hour and leaves the rest empty', () => {
    const option = heatmapOption(cells, 'xp', theme);
    expect(seriesOf(option)[0]?.data).toEqual([
      [18, 0, 60_000],
      [19, 0, '-'],
    ]);
    expect(option.visualMap).toMatchObject({ min: 0, max: 60_000 });
  });

  it('counts active minutes for the active measure', () => {
    expect(seriesOf(heatmapOption(cells, 'active', theme))[0]?.data?.[0]).toEqual([18, 0, 30]);
  });
});

describe('scatterOption', () => {
  it('groups the dots by main activity, three named and Other, each carrying its session id', () => {
    const sessions = [
      card({ id: 'a' }),
      card({ id: 'b', main: { kind: 'boss', name: 'Zulrah' } }),
      card({ id: 'c', main: { kind: 'skill', name: 'Mining' } }),
      card({ id: 'd', main: { kind: 'skill', name: 'Cooking' } }),
      card({ id: 'e', main: null }),
    ];
    const option = scatterOption(
      {
        sessions,
        measure: 'xp',
        activities: ['Ranged', 'Zulrah', 'Mining', 'Cooking'],
        timezone: 'UTC',
      },
      theme,
    );
    const series = seriesOf(option);
    expect(series.map((s) => s.name)).toEqual(['Ranged', 'Zulrah', 'Mining', 'Other']);
    expect(series[3]?.data).toEqual([
      { id: 'd', value: [1, 60_000] },
      { id: 'e', value: [1, 60_000] },
    ]);
  });
});

describe('flat and short ranges', () => {
  it('keeps whole steps on an axis whose values are all 0, and at least an hour of session length', () => {
    const option = scatterOption(
      { sessions: [card({ id: 'a', value: 0 })], measure: 'xp', activities: [], timezone: 'UTC' },
      theme,
    );
    expect(option.yAxis).toMatchObject({ minInterval: 1 });
    const max = (option.xAxis as { max: (e: { max: number }) => number }).max;
    expect(max({ max: 0.01 })).toBe(1);
    expect(max({ max: 3 })).toBe(3);
  });

  it('labels hours under one in minutes', () => {
    expect([0, 5 / 60, 0.5, 1, 1.5].map(hoursAxis)).toEqual(['0h', '5m', '30m', '1h', '1.5h']);
  });
});

describe('rateThroughOption', () => {
  it('draws the band as two stacked lines under the median', () => {
    const steps: RateStep[] = [
      { minute: 0, sessions: 3, p25: 10, median: 20, p75: 40 },
      { minute: 30, sessions: 2, p25: 5, median: 10, p75: 15 },
    ];
    const series = seriesOf(rateThroughOption(steps, 'xp', theme));
    expect(series.map((s) => [s.name, s.stack, s.data])).toEqual([
      ['Lower quartile', 'band', [10, 5]],
      ['Middle half', 'band', [30, 10]],
      ['Median', undefined, [20, 10]],
    ]);
  });
});

describe('foldTimeByActivity', () => {
  it('keeps the page’s named activities and folds the rest into Other', () => {
    const folded = foldTimeByActivity(
      {
        days: ['2026-10-05', '2026-10-06'],
        series: [
          { name: 'Fishing', ms: [10, 0] },
          { name: 'Zulrah', ms: [5, 5] },
          { name: 'Mining', ms: [1, 1] },
          { name: 'Cooking', ms: [0, 2] },
          { name: 'Other', ms: [3, 0] },
        ],
      },
      ['Zulrah', 'Fishing'],
    );
    expect(folded).toEqual([
      { name: 'Zulrah', ms: [5, 5] },
      { name: 'Fishing', ms: [10, 0] },
      { name: 'Mining', ms: [1, 1] },
      { name: 'Other', ms: [3, 2] },
    ]);
  });
});

describe('timelineOption', () => {
  const timeline: SessionTimeline = {
    session: card({
      xpBySkill: [
        { skill: 'Ranged', xp: 2_000 },
        { skill: 'Hitpoints', xp: 700 },
        { skill: 'Defence', xp: 100 },
        { skill: 'Magic', xp: 50 },
      ],
    }),
    buckets: [
      {
        at: '2026-10-05T18:00:00.000Z',
        onlineMs: 300_000,
        active: true,
        xp: { Ranged: 1_000, Magic: 50 },
        gp: 0,
      },
      { at: '2026-10-05T18:05:00.000Z', onlineMs: 300_000, active: false, xp: {}, gp: 0 },
      { at: '2026-10-05T18:10:00.000Z', onlineMs: 300_000, active: false, xp: {}, gp: 0 },
      {
        at: '2026-10-05T18:15:00.000Z',
        onlineMs: 300_000,
        active: true,
        xp: { Ranged: 1_000, Hitpoints: 700, Defence: 100 },
        gp: 5_000_000,
      },
    ],
    markers: [
      { at: '2026-10-05T18:16:30.000Z', type: 'loot', line: 'A drop', value: 5_000_000 },
      { at: '2026-10-05T18:01:00.000Z', type: 'level_up', line: 'A level', value: null },
    ],
  };

  it('stacks XP per hour by the session’s top three skills and Other, shading the idle stretch', () => {
    const series = seriesOf(timelineOption(timeline, 'UTC', theme));
    expect(series.slice(0, 4).map((s) => [s.name, s.data])).toEqual([
      ['Ranged', [12_000, 0, 0, 12_000]],
      ['Hitpoints', [0, 0, 0, 8_400]],
      ['Defence', [0, 0, 0, 1_200]],
      ['Other', [600, 0, 0, 0]],
    ]);
    expect(series[0]?.markArea).toMatchObject({ data: [[{ xAxis: 1 }, { xAxis: 2 }]] });
  });

  it('puts each marker on the baseline of its bucket, a drop sized by its value', () => {
    const series = seriesOf(timelineOption(timeline, 'UTC', theme));
    const drops = series.find((s) => s.name === 'Drops');
    expect(drops?.data).toEqual([{ value: [3, 0], symbolSize: dropSize(5_000_000) }]);
    expect(series.find((s) => s.name === 'Level-ups')?.data).toEqual([
      { value: [0, 0], symbolSize: 9 },
    ]);
  });

  it('finds the bucket of a moment', () => {
    expect(bucketIndex(timeline.buckets, '2026-10-05T17:59:00.000Z')).toBe(-1);
    expect(bucketIndex(timeline.buckets, '2026-10-05T18:09:59.000Z')).toBe(1);
    expect(dropSize(null)).toBe(8);
    expect(dropSize(1e12)).toBe(20);
  });
});

describe('boss trends', () => {
  const periods: BossPeriod[] = [
    { start: '2026-10-05', kills: 20, gp: 2_100_000 },
    { start: '2026-10-06', kills: 0, gp: 0 },
    { start: '2026-10-07', kills: 3, gp: 100_000 },
  ];

  it('bars the kills per period', () => {
    expect(seriesOf(bossKillsOption(periods, 'day', theme))[0]?.data).toEqual([20, 0, 3]);
  });

  it('adds up loot against kills, skipping empty periods', () => {
    expect(lootAgainstKills(periods)).toEqual([
      { start: '2026-10-05', kills: 20, gp: 2_100_000 },
      { start: '2026-10-07', kills: 23, gp: 2_200_000 },
    ]);
    expect(seriesOf(bossLootOption(periods, 'day', theme))[0]?.data).toEqual([
      [0, 0],
      [20, 2_100_000],
      [23, 2_200_000],
    ]);
  });
});

describe('sessionsInCell', () => {
  it('lists the sessions with online time in a weekday and hour of the viewer’s zone', () => {
    const sessions = [
      card({ id: 'a', start: '2026-10-05T17:30:00.000Z', end: '2026-10-05T18:10:00.000Z' }),
      card({ id: 'b', start: '2026-10-05T19:00:00.000Z', end: '2026-10-05T19:30:00.000Z' }),
    ];
    expect(sessionsInCell(sessions, { weekday: 0, hour: 18 }, 'UTC').map((s) => s.id)).toEqual([
      'a',
    ]);
    // 18:00 UTC is 20:00 in Amsterdam (CEST).
    expect(
      sessionsInCell(sessions, { weekday: 0, hour: 20 }, 'Europe/Amsterdam').map((s) => s.id),
    ).toEqual(['a']);
  });
});

describe('format', () => {
  it('writes amounts, rates and ETAs', () => {
    expect(formatAmount('xp', 12_345)).toBe('12,345 XP');
    expect(formatAmount('kills', 1)).toBe('1 kill');
    expect(formatAmount('active', 5_400_000)).toBe('1h 30m');
    expect(formatRate('gp', 1_200_000)).toBe('1.2M gp/h');
    expect(formatRate('active', 0.64)).toBe('64% active');
    expect(formatRate('kills', 2.345)).toBe('2.3 kills/h');
    expect(formatRate('xp', null)).toBe('—');
    expect(formatSessionMinute(90)).toBe('1:30');
    expect(formatEtaDays(0)).toBe('reached');
    expect(formatEtaDays(2.2)).toBe('3 days');
    expect(formatEtaDays(120)).toBe('about 4 months');
  });
});

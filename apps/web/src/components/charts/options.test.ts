import { describe, expect, it } from 'vitest';
import {
  FALLBACK_THEME,
  SERIES_DARK,
  escapeHtml,
  playtimeOption,
  stepPoints,
  wealthCalendar,
  wealthOption,
  xpChartOption,
  type ChartTheme,
} from './options';

const TO = new Date('2026-09-29T12:00:00.000Z');

describe('stepPoints', () => {
  it('sorts, converts to ms and carries the last value to `to`', () => {
    expect(
      stepPoints(
        [
          ['2026-09-29T10:00:00.000Z', 2_000],
          ['2026-09-28T10:00:00.000Z', 1_000],
        ],
        TO,
      ),
    ).toEqual([
      [Date.parse('2026-09-28T10:00:00.000Z'), 1_000],
      [Date.parse('2026-09-29T10:00:00.000Z'), 2_000],
      [TO.getTime(), 2_000],
    ]);
  });

  it('drops points after `to` and invalid ones, and leaves an empty series empty', () => {
    expect(
      stepPoints(
        [
          ['garbage', 5],
          ['2026-09-29T12:00:00.000Z', 3],
          ['2026-09-30T00:00:00.000Z', 9],
        ],
        TO,
      ),
    ).toEqual([[TO.getTime(), 3]]);
    expect(stepPoints([], TO)).toEqual([]);
  });
});

describe('xpChartOption', () => {
  const option = xpChartOption(
    {
      skill: 'Attack',
      points: [['2026-09-28T00:00:00.000Z', 1_000]],
      from: new Date('2026-09-28T00:00:00.000Z'),
      to: TO,
    },
    FALLBACK_THEME,
  );

  it('draws a step line (step: end) with a thin line and a light area wash', () => {
    const [series] = option.series as Record<string, unknown>[];
    expect(series).toMatchObject({
      type: 'line',
      step: 'end',
      showSymbol: false,
      lineStyle: { width: 2 },
      areaStyle: { opacity: 0.1 },
    });
    expect(series?.data).toEqual([
      [Date.parse('2026-09-28T00:00:00.000Z'), 1_000],
      [TO.getTime(), 1_000],
    ]);
  });

  it('spans the requested window on a time axis and fits the y-axis to the data', () => {
    expect(option.xAxis).toMatchObject({
      type: 'time',
      min: Date.parse('2026-09-28T00:00:00.000Z'),
      max: TO.getTime(),
    });
    expect(option.yAxis).toMatchObject({ type: 'value', scale: true });
    expect(option.legend).toBeUndefined();
  });

  it('formats the tooltip with the exact XP and escapes the skill name', () => {
    const evil = xpChartOption(
      { skill: '<img src=x>', points: [], from: TO, to: TO },
      FALLBACK_THEME,
    );
    const tooltip = evil.tooltip as { formatter: (p: unknown) => string };
    const html = tooltip.formatter([{ value: [TO.getTime(), 13_034_431] }]);
    expect(html).toContain('13,034,431 XP');
    expect(html).toContain('&lt;img src=x&gt;');
    expect(html).not.toContain('<img');
    expect(tooltip.formatter([])).toBe('');
  });

  it('draws dots when the history covers only a sliver of the window (a line would be invisible)', () => {
    const fresh = xpChartOption(
      {
        skill: 'Overall',
        points: [['2026-09-29T11:58:00.000Z', 534_946_983]],
        from: new Date('2026-08-30T12:00:00.000Z'),
        to: TO,
      },
      FALLBACK_THEME,
    );
    const [series] = fresh.series as Record<string, unknown>[];
    expect(series).toMatchObject({ showSymbol: true, itemStyle: { borderWidth: 2 } });
  });

  it('uses the theme colours (dark steps in dark mode)', () => {
    const dark: ChartTheme = { ...FALLBACK_THEME, dark: true, series: SERIES_DARK };
    const [series] = xpChartOption({ skill: 'Attack', points: [], from: TO, to: TO }, dark)
      .series as { color: string }[];
    expect(series?.color).toBe(SERIES_DARK[0]);
  });
});

describe('playtimeOption', () => {
  const days = [
    { day: '2026-09-28', ms: 90 * 60 * 1000 },
    { day: '2026-09-29', ms: 0 },
  ];
  const option = playtimeOption(days, FALLBACK_THEME);

  it('draws capped, rounded bars in hours', () => {
    const [series] = option.series as Record<string, unknown>[];
    expect(series).toMatchObject({
      type: 'bar',
      barMaxWidth: 24,
      data: [1.5, 0],
      itemStyle: { borderRadius: [4, 4, 0, 0] },
    });
    expect((option.xAxis as { data: string[] }).data).toHaveLength(2);
  });

  it('shows the exact duration in the tooltip', () => {
    const tooltip = option.tooltip as { formatter: (p: unknown) => string };
    expect(tooltip.formatter([{ dataIndex: 0, value: 1.5 }])).toContain('1h 30m');
    expect(tooltip.formatter([{ dataIndex: 7 }])).toBe('');
  });
});

describe('wealthCalendar', () => {
  it('fills every day between the first and the last with nulls where there is no row', () => {
    expect(
      wealthCalendar([
        { day: '2026-09-29', lastValue: 3, maxValue: 4 },
        { day: '2026-09-27', lastValue: 1, maxValue: 2 },
        { day: 'nonsense', lastValue: 9, maxValue: 9 },
      ]),
    ).toEqual([
      { day: '2026-09-27', lastValue: 1, maxValue: 2 },
      { day: '2026-09-28', lastValue: null, maxValue: null },
      { day: '2026-09-29', lastValue: 3, maxValue: 4 },
    ]);
    expect(wealthCalendar([])).toEqual([]);
  });

  it('keeps the newest 400 days of a longer history', () => {
    const cal = wealthCalendar([
      { day: '2020-01-01', lastValue: 1, maxValue: 1 },
      { day: '2026-09-29', lastValue: 2, maxValue: 2 },
    ]);
    expect(cal).toHaveLength(400);
    expect(cal.at(-1)?.day).toBe('2026-09-29');
  });
});

describe('wealthOption', () => {
  it('draws two lines with a legend and lists both in the tooltip', () => {
    const option = wealthOption(
      [
        { day: '2026-09-28', lastValue: 1_000_000, maxValue: 2_500_000 },
        { day: '2026-09-29', lastValue: 1_200_000, maxValue: 1_300_000 },
      ],
      FALLBACK_THEME,
    );
    const series = option.series as { type: string; name: string; data: unknown[] }[];
    expect(series.map((s) => [s.type, s.name])).toEqual([
      ['line', 'End of day'],
      ['line', 'Daily high'],
    ]);
    expect(series[0]?.data).toEqual([1_000_000, 1_200_000]);
    // The key is a plain line: the series' dot border (card colour) must not paint over it.
    expect(option.legend).toMatchObject({ itemStyle: { borderWidth: 0 } });
    const tooltip = option.tooltip as { formatter: (p: unknown) => string };
    const html = tooltip.formatter([{ dataIndex: 0 }]);
    expect(html).toContain('1M gp');
    expect(html).toContain('2.5M gp');
  });
});

describe('escapeHtml', () => {
  it('escapes markup characters', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;',
    );
  });
});

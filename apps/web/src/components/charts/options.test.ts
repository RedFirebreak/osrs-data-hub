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
      timezone: 'UTC',
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
      { skill: '<img src=x>', points: [], from: TO, to: TO, timezone: 'UTC' },
      FALLBACK_THEME,
    );
    const tooltip = evil.tooltip as { formatter: (p: unknown) => string };
    const html = tooltip.formatter([{ value: [TO.getTime(), 13_034_431] }]);
    expect(html).toContain('13,034,431 XP');
    expect(html).toContain('&lt;img src=x&gt;');
    expect(html).not.toContain('<img');
    expect(tooltip.formatter([])).toBe('');
  });

  it("writes the tooltip's moment in the viewer's time zone, not the runtime's", () => {
    // 22:30 UTC is the next morning in Tokyo and the same afternoon in Los Angeles: at most one of
    // the two can be the zone the tests run in. (August: en-GB's short "Sep" or "Sept" depends on the
    // runtime's ICU version.)
    const at = Date.parse('2026-08-29T22:30:00.000Z');
    const titleIn = (timezone: string) => {
      const option = xpChartOption(
        { skill: 'Attack', points: [], from: TO, to: TO, timezone },
        FALLBACK_THEME,
      );
      const tooltip = option.tooltip as { formatter: (p: unknown) => string };
      return /^<div[^>]*>([^<]*)<\/div>/.exec(tooltip.formatter([{ value: [at, 1] }]))?.[1];
    };
    expect(titleIn('Asia/Tokyo')).toBe('30 Aug 2026, 07:30');
    expect(titleIn('America/Los_Angeles')).toBe('29 Aug 2026, 15:30');
    expect(titleIn('UTC')).toBe('29 Aug 2026, 22:30');
    // A zone this runtime doesn't know falls back to UTC (formatInZone).
    expect(titleIn('Mars/Olympus')).toBe('29 Aug 2026, 22:30');
  });

  it('draws dots when the history covers only a sliver of the window (a line would be invisible)', () => {
    const fresh = xpChartOption(
      {
        skill: 'Overall',
        points: [['2026-09-29T11:58:00.000Z', 534_946_983]],
        from: new Date('2026-08-30T12:00:00.000Z'),
        to: TO,
        timezone: 'UTC',
      },
      FALLBACK_THEME,
    );
    const [series] = fresh.series as Record<string, unknown>[];
    expect(series).toMatchObject({ showSymbol: true, itemStyle: { borderWidth: 2 } });
  });

  it('uses the theme colours (dark steps in dark mode)', () => {
    const dark: ChartTheme = { ...FALLBACK_THEME, dark: true, series: SERIES_DARK };
    const [series] = xpChartOption(
      { skill: 'Attack', points: [], from: TO, to: TO, timezone: 'UTC' },
      dark,
    ).series as { color: string }[];
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

/**
 * The whole option object of each builder, so a change to the shared helpers (baseOption,
 * axisTooltip, the axes, the series) that alters any chart shows up here. A theme with a different
 * value per field, so a swapped colour is caught too.
 */
describe('the full option of each chart', () => {
  const PIN: ChartTheme = {
    dark: false,
    mutedText: '#111111',
    text: '#222222',
    grid: '#333333',
    tooltipBackground: '#444444',
    tooltipBorder: '#555555',
    fontFamily: 'Test Sans',
    series: ['#aa0000', '#00bb00', '#0000cc'],
  };
  const GRID = {
    left: 4,
    right: 12,
    top: 12,
    bottom: 4,
    outerBoundsMode: 'same',
    outerBoundsContain: 'axisLabel',
  };
  const TOOLTIP_BOX = {
    confine: true,
    backgroundColor: '#444444',
    borderColor: '#555555',
    borderWidth: 1,
    padding: [6, 10],
    textStyle: { color: '#222222', fontFamily: 'Test Sans', fontSize: 12 },
    extraCssText: 'border-radius: 8px; box-shadow: 0 4px 12px rgb(0 0 0 / 0.12);',
    trigger: 'axis',
    formatter: expect.any(Function),
  };
  const AXIS_LABEL = { color: '#111111', fontFamily: 'Test Sans', fontSize: 11 };
  const LINE_POINTER = { type: 'line', lineStyle: { color: '#111111', width: 1 } };
  const SPLIT_LINE = { lineStyle: { color: '#333333', width: 1 } };
  const row = (color: string, value: string, label: string) =>
    `<div style="display:flex;align-items:center;gap:6px">` +
    `<span style="display:inline-block;width:10px;height:2px;border-radius:1px;background:${color}"></span>` +
    `<strong>${value}</strong><span style="opacity:.7">${label}</span></div>`;
  const title = (text: string) => `<div style="opacity:.7;margin-bottom:2px">${text}</div>`;
  // The day labels of the per-day charts follow the runner's locale; the day itself is a calendar
  // date (UTC).
  const shortDay = (day: string) =>
    new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(
      new Date(`${day}T00:00:00Z`),
    );
  const longDay = (day: string) =>
    new Intl.DateTimeFormat(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    }).format(new Date(`${day}T00:00:00Z`));
  const formatterOf = (option: { tooltip?: unknown }) =>
    (option.tooltip as { formatter: (p: unknown) => string }).formatter;
  const yLabelOf = (option: { yAxis?: unknown }) =>
    (option.yAxis as { axisLabel: { formatter: (v: number) => string } }).axisLabel.formatter;

  it('xpChartOption', () => {
    const from = new Date('2026-09-28T00:00:00.000Z');
    const option = xpChartOption(
      {
        skill: 'Attack',
        points: [['2026-09-28T00:00:00.000Z', 1_000]],
        from,
        to: TO,
        timezone: 'Asia/Tokyo',
      },
      PIN,
    );
    expect(option).toStrictEqual({
      animation: false,
      textStyle: { fontFamily: 'Test Sans' },
      grid: GRID,
      tooltip: { ...TOOLTIP_BOX, axisPointer: LINE_POINTER },
      xAxis: {
        type: 'time',
        min: from.getTime(),
        max: TO.getTime(),
        axisLine: { lineStyle: { color: '#333333' } },
        axisTick: { show: false },
        axisLabel: { ...AXIS_LABEL, hideOverlap: true },
        splitLine: { show: false },
      },
      yAxis: {
        type: 'value',
        scale: true,
        axisLabel: { ...AXIS_LABEL, formatter: expect.any(Function) },
        splitLine: SPLIT_LINE,
      },
      series: [
        {
          type: 'line',
          name: 'Attack',
          step: 'end',
          showSymbol: false,
          symbolSize: 8,
          data: [
            [from.getTime(), 1_000],
            [TO.getTime(), 1_000],
          ],
          color: '#aa0000',
          lineStyle: { width: 2, color: '#aa0000', cap: 'round', join: 'round' },
          itemStyle: { color: '#aa0000', borderColor: '#444444', borderWidth: 2 },
          areaStyle: { color: '#aa0000', opacity: 0.1 },
          emphasis: { disabled: true },
        },
      ],
    });
    // 12:00 UTC, in the viewer's zone (Settings).
    expect(formatterOf(option)([{ value: [Date.parse('2026-08-29T12:00:00Z'), 1_000] }])).toBe(
      title('29 Aug 2026, 21:00') + row('#aa0000', '1,000 XP', 'Attack'),
    );
    expect(yLabelOf(option)(13_200_000)).toBe('13.2M');
  });

  it('playtimeOption', () => {
    const option = playtimeOption(
      [
        { day: '2026-09-28', ms: 90 * 60 * 1000 },
        { day: '2026-09-29', ms: 0 },
      ],
      PIN,
    );
    expect(option).toStrictEqual({
      animation: false,
      textStyle: { fontFamily: 'Test Sans' },
      grid: GRID,
      tooltip: { ...TOOLTIP_BOX, axisPointer: { type: 'shadow', shadowStyle: { opacity: 0.08 } } },
      xAxis: {
        type: 'category',
        data: [shortDay('2026-09-28'), shortDay('2026-09-29')],
        axisLine: { lineStyle: { color: '#333333' } },
        axisTick: { show: false },
        axisLabel: { ...AXIS_LABEL, hideOverlap: true },
      },
      yAxis: {
        type: 'value',
        minInterval: 1,
        axisLabel: { ...AXIS_LABEL, formatter: expect.any(Function) },
        splitLine: SPLIT_LINE,
      },
      series: [
        {
          type: 'bar',
          name: 'Playtime',
          barMaxWidth: 24,
          data: [1.5, 0],
          itemStyle: { color: '#aa0000', borderRadius: [4, 4, 0, 0] },
          emphasis: { itemStyle: { opacity: 0.85 } },
        },
      ],
    });
    expect(formatterOf(option)([{ dataIndex: 0 }])).toBe(
      title(longDay('2026-09-28')) + row('#aa0000', '1h 30m', 'played'),
    );
    expect(yLabelOf(option)(3)).toBe('3h');
    // An unparsable day is shown as it came.
    expect(
      (playtimeOption([{ day: 'nonsense', ms: 0 }], PIN).xAxis as { data: string[] }).data,
    ).toEqual(['nonsense']);
  });

  it('wealthOption', () => {
    const option = wealthOption(
      [
        { day: '2026-09-27', lastValue: 1_000_000, maxValue: 2_500_000 },
        { day: '2026-09-29', lastValue: 1_200_000, maxValue: 1_300_000 },
      ],
      PIN,
    );
    const line = (name: string, color: string, data: (number | null)[]) => ({
      type: 'line',
      name,
      showSymbol: true,
      symbolSize: 8,
      connectNulls: true,
      data,
      color,
      lineStyle: { width: 2, color, cap: 'round', join: 'round' },
      itemStyle: { color, borderColor: '#444444', borderWidth: 2 },
      emphasis: { disabled: true },
    });
    expect(option).toStrictEqual({
      animation: false,
      textStyle: { fontFamily: 'Test Sans' },
      grid: { ...GRID, top: 36 },
      legend: {
        top: 0,
        left: 0,
        icon: 'roundRect',
        itemWidth: 12,
        itemHeight: 3,
        itemStyle: { borderWidth: 0 },
        textStyle: { color: '#111111', fontFamily: 'Test Sans', fontSize: 12 },
        data: ['End of day', 'Daily high'],
      },
      tooltip: { ...TOOLTIP_BOX, axisPointer: LINE_POINTER },
      xAxis: {
        type: 'category',
        boundaryGap: false,
        data: [shortDay('2026-09-27'), shortDay('2026-09-28'), shortDay('2026-09-29')],
        axisLine: { lineStyle: { color: '#333333' } },
        axisTick: { show: false },
        axisLabel: { ...AXIS_LABEL, hideOverlap: true },
      },
      yAxis: {
        type: 'value',
        scale: true,
        axisLabel: { ...AXIS_LABEL, formatter: expect.any(Function) },
        splitLine: SPLIT_LINE,
      },
      series: [
        line('End of day', '#aa0000', [1_000_000, null, 1_200_000]),
        line('Daily high', '#00bb00', [2_500_000, null, 1_300_000]),
      ],
    });
    expect(formatterOf(option)([{ dataIndex: 0 }])).toBe(
      title(longDay('2026-09-27')) +
        row('#aa0000', '1M gp', 'End of day') +
        row('#00bb00', '2.5M gp', 'Daily high'),
    );
    expect(formatterOf(option)([{ dataIndex: 1 }])).toBe(
      title(longDay('2026-09-28')) + '<div style="opacity:.7">No data this day</div>',
    );
    expect(formatterOf(option)([{ dataIndex: 9 }])).toBe('');
    expect(yLabelOf(option)(13_200_000)).toBe('13.2M');
  });

  it('hides the dots of a wealth line over more than 31 days', () => {
    const option = wealthOption(
      [
        { day: '2026-08-01', lastValue: 1, maxValue: 1 },
        { day: '2026-09-29', lastValue: 2, maxValue: 2 },
      ],
      PIN,
    );
    expect((option.series as { showSymbol: boolean }[]).map((s) => s.showSymbol)).toEqual([
      false,
      false,
    ]);
  });
});

describe('escapeHtml', () => {
  it('escapes markup characters', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;',
    );
  });
});

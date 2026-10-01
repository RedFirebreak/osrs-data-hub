/**
 * The two per-day charts as their markup: the chart element's label and the "Show as table"
 * alternative under it (the chart itself is client-only, so it is stubbed with its label).
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { PlaytimeChart } from './playtime-chart';
import { WealthChart } from './wealth-chart';

vi.mock('./lazy-echart', () => ({
  LazyEChart: ({ label }: { label: string }) => <div role="img" aria-label={label} />,
}));

const DETAILS =
  '<details class="mt-2 text-xs text-muted-foreground">' +
  '<summary class="cursor-pointer select-none hover:text-foreground">Show as table</summary>' +
  '<table class="mt-2 w-full text-left tabular-nums">';
const headings = (first: string, ...rest: string[]) =>
  `<thead><tr><th scope="col" class="py-1 font-medium">${first}</th>` +
  rest.map((h) => `<th scope="col" class="py-1 text-right font-medium">${h}</th>`).join('') +
  '</tr></thead>';
const row = (day: string, ...values: string[]) =>
  `<tr class="border-t"><td class="py-1"><time dateTime="${day}">${day}</time></td>` +
  values.map((v) => `<td class="py-1 text-right">${v}</td>`).join('') +
  '</tr>';

describe('PlaytimeChart', () => {
  it('labels the chart with the total and lists the days oldest first', () => {
    const html = renderToStaticMarkup(
      <PlaytimeChart
        className="mt-1"
        days={[
          { day: '2026-09-28', ms: 90 * 60 * 1000 },
          { day: '2026-09-29', ms: 0 },
        ]}
      />,
    );
    expect(html).toBe(
      '<div class="mt-1">' +
        '<div role="img" aria-label="Playtime per day over the last 2 days, 1h 30m in total"></div>' +
        DETAILS +
        headings('Day', 'Played') +
        `<tbody>${row('2026-09-28', '1h 30m')}${row('2026-09-29', '—')}</tbody>` +
        '</table></details></div>',
    );
  });
});

describe('WealthChart', () => {
  it('labels the chart with the newest value and lists the days newest first', () => {
    const html = renderToStaticMarkup(
      <WealthChart
        days={[
          { day: '2026-09-28', lastValue: 1_000_000, maxValue: 2_500_000 },
          { day: '2026-09-29', lastValue: 1_200_000, maxValue: 1_300_000 },
        ]}
      />,
    );
    expect(html).toBe(
      '<div>' +
        '<div role="img" aria-label="Carried wealth per day over 2 days, 1.2M gp at the end of 2026-09-29"></div>' +
        DETAILS +
        headings('Day (UTC)', 'End of day', 'Daily high') +
        `<tbody>${row('2026-09-29', '1.2M', '1.3M')}${row('2026-09-28', '1M', '2.5M')}</tbody>` +
        '</table></details></div>',
    );
  });

  it('says only the period when there are no days', () => {
    expect(renderToStaticMarkup(<WealthChart days={[]} />)).toContain(
      'aria-label="Carried wealth per day over 0 days"',
    );
  });
});

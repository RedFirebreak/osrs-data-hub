'use client';
/**
 * The one ECharts wrapper. Registers only what the hub's charts use (line, bar, scatter and heatmap
 * series; grid, legend, tooltip, visual map, mark areas and lines, the brush; the canvas renderer)
 * from the modular `echarts/*` entry points, so the bundle stays small; resizes with its container (ResizeObserver); follows light/dark mode by resolving the
 * page's CSS variables and re-resolving them when the theme changes (the `.dark` class or other
 * attribute on <html>, or the OS colour scheme); disposes the instance on unmount.
 *
 * Never import this module from a server component: load it through charts/lazy-echart.tsx
 * (next/dynamic with ssr: false), so server rendering never imports echarts.
 *
 *   <EChart option={(theme) => xpChartOption(input, theme)} label="Attack XP over 30 days" />
 *
 * `option` is a function of the resolved theme; pass a memoized one (useCallback/useMemo) so the
 * chart is only re-set when its data or the theme changes.
 *
 * `onEvents` listens to the chart's own events (a click on a mark, the end of a brush); `brush`
 * turns the pointer into a horizontal brush on the x-axis (the option must have a `brush`
 * component), so a drag selects a span instead of needing a toolbox button first.
 */
import { BarChart, HeatmapChart, LineChart, ScatterChart } from 'echarts/charts';
import {
  BrushComponent,
  GridComponent,
  LegendComponent,
  MarkAreaComponent,
  MarkLineComponent,
  ToolboxComponent,
  TooltipComponent,
  VisualMapContinuousComponent,
} from 'echarts/components';
import { init, use as registerParts, type EChartsType } from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { cn } from '@/lib/utils';
import {
  FALLBACK_THEME,
  SERIES_DARK,
  SERIES_LIGHT,
  type ChartOption,
  type ChartTheme,
} from './options';

// Aliased: eslint's react-hooks rule would take echarts' `use` for React's.
registerParts([
  BarChart,
  LineChart,
  ScatterChart,
  HeatmapChart,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  VisualMapContinuousComponent,
  MarkAreaComponent,
  MarkLineComponent,
  BrushComponent,
  // The brush component reads its buttons from the toolbox and warns without it; no toolbox is shown.
  ToolboxComponent,
  CanvasRenderer,
]);

/** The chart events a caller may listen to. */
export type EChartEventName = 'click' | 'brushEnd';
export type EChartEvents = Partial<Record<EChartEventName, (params: unknown) => void>>;

export interface EChartProps {
  option: (theme: ChartTheme) => ChartOption;
  /** What the chart shows, for screen readers (the element is role="img"). */
  label: string;
  /** Data is reloading: the previous render stays, dimmed, instead of a skeleton. */
  busy?: boolean;
  /** Sizing (default h-64 w-full). */
  className?: string;
  /** Handlers of the chart's events (see the file comment). */
  onEvents?: EChartEvents;
  /** Dragging across the plot brushes a span of the x-axis (see the file comment). */
  brush?: boolean;
}

const EVENT_NAMES: readonly EChartEventName[] = ['click', 'brushEnd'];

export function EChart({
  option,
  label,
  busy = false,
  className,
  onEvents,
  brush = false,
}: EChartProps) {
  const container = useRef<HTMLDivElement>(null);
  const chart = useRef<EChartsType | null>(null);
  const theme = useChartTheme();
  // The latest handlers, so a new render's closures are used without rebinding.
  const handlers = useRef(onEvents);
  useEffect(() => {
    handlers.current = onEvents;
  });

  useEffect(() => {
    const el = container.current;
    if (!el) return;
    const instance = init(el, undefined, { renderer: 'canvas' });
    chart.current = instance;
    for (const name of EVENT_NAMES) {
      instance.on(name, (...args: unknown[]) => {
        handlers.current?.[name]?.(args[0]);
      });
    }
    const observer = new ResizeObserver(() => instance.resize());
    observer.observe(el);
    return () => {
      observer.disconnect();
      chart.current = null;
      instance.dispose();
    };
  }, []);

  useEffect(() => {
    const instance = chart.current;
    if (!instance) return;
    instance.setOption(option(theme), { notMerge: true, lazyUpdate: true });
    if (brush) {
      instance.dispatchAction({
        type: 'takeGlobalCursor',
        key: 'brush',
        brushOption: { brushType: 'lineX', brushMode: 'single' },
      });
    }
  }, [option, theme, brush]);

  return (
    <div
      ref={container}
      role="img"
      aria-label={label}
      aria-busy={busy || undefined}
      className={cn(
        'h-64 w-full min-w-0 transition-opacity duration-200',
        busy && 'opacity-50',
        className,
      )}
    />
  );
}

// --- Theme ------------------------------------------------------------------------------------

const DARK_QUERY = '(prefers-color-scheme: dark)';

function subscribeTheme(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class', 'style', 'data-theme'],
  });
  const media = window.matchMedia(DARK_QUERY);
  media.addEventListener('change', onChange);
  return () => {
    observer.disconnect();
    media.removeEventListener('change', onChange);
  };
}

let cached: { key: string; theme: ChartTheme } | null = null;

/** The resolved theme; recomputed only when <html>'s theme attributes or the OS scheme change. */
function themeSnapshot(): ChartTheme {
  const html = document.documentElement;
  const key = [
    html.className,
    html.getAttribute('style') ?? '',
    html.dataset.theme ?? '',
    String(window.matchMedia(DARK_QUERY).matches),
  ].join('|');
  if (cached?.key !== key) cached = { key, theme: resolveTheme() };
  return cached.theme;
}

function serverTheme(): ChartTheme {
  return FALLBACK_THEME;
}

function useChartTheme(): ChartTheme {
  return useSyncExternalStore(subscribeTheme, themeSnapshot, serverTheme);
}

let probeCanvas: CanvasRenderingContext2D | null | undefined;

/**
 * A CSS colour as `rgba(…)`. The theme's variables are oklch(), which ECharts' own colour parser
 * doesn't understand (it lightens and blends colours for hover states and legends), so each one is
 * painted on a 1×1 canvas and read back.
 */
function toRgba(color: string): string | null {
  probeCanvas ??= document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  const ctx = probeCanvas;
  if (!ctx || !color) return null;
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = '#000';
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 1, 1);
  const [r = 0, g = 0, b = 0, a = 255] = ctx.getImageData(0, 0, 1, 1).data;
  return `rgba(${r}, ${g}, ${b}, ${Math.round((a / 255) * 100) / 100})`;
}

/** The computed value of a colour variable as rgba, or `fallback`. */
function cssColor(variable: string, fallback: string): string {
  const probe = document.createElement('span');
  probe.style.display = 'none';
  probe.style.color = `var(${variable}, ${fallback})`;
  document.body.appendChild(probe);
  const computed = getComputedStyle(probe).color;
  probe.remove();
  return toRgba(computed) ?? fallback;
}

/** Relative luminance (0…1) of an `rgba(r, g, b, a)` string; 1 when unparsable. */
function luminance(rgba: string): number {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(rgba);
  if (!m) return 1;
  const [r, g, b] = [m[1], m[2], m[3]].map((v) => {
    const c = Number(v) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function resolveTheme(): ChartTheme {
  const surface = cssColor('--card', '#ffffff');
  const dark = luminance(surface) < 0.4;
  return {
    dark,
    mutedText: cssColor('--muted-foreground', FALLBACK_THEME.mutedText),
    text: cssColor('--popover-foreground', FALLBACK_THEME.text),
    grid: cssColor('--border', FALLBACK_THEME.grid),
    tooltipBackground: cssColor('--popover', FALLBACK_THEME.tooltipBackground),
    tooltipBorder: cssColor('--border', FALLBACK_THEME.tooltipBorder),
    fontFamily: getComputedStyle(document.body).fontFamily || FALLBACK_THEME.fontFamily,
    series: dark ? SERIES_DARK : SERIES_LIGHT,
  };
}

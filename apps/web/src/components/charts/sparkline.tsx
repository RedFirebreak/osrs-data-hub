/**
 * A small line with no axes, beside a number that already says the amount: the shape of a week, not
 * its values. Plain SVG, so it renders on the server and needs no chart library. Decorative
 * (`aria-hidden`): the text next to it carries the meaning. Server- and client-safe.
 *
 *   <Sparkline points={comparison.current} className="h-10 text-foreground" />
 */
import { cn } from '@/lib/utils';

const WIDTH = 100;
const HEIGHT = 32;
/** Room for the stroke at the top and bottom edges. */
const INSET = 2;

/** The polyline's points for `[x, y]` pairs, scaled into the box; '' for fewer than two points. */
export function sparklinePoints(points: readonly (readonly [number, number])[]): string {
  if (points.length < 2) return '';
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  const minX = Math.min(...xs);
  const spanX = Math.max(...xs) - minX || 1;
  const minY = Math.min(...ys);
  const spanY = Math.max(...ys) - minY || 1;
  return points
    .map(([x, y]) => {
      const px = ((x - minX) / spanX) * WIDTH;
      const py = HEIGHT - INSET - ((y - minY) / spanY) * (HEIGHT - 2 * INSET);
      return `${Math.round(px * 10) / 10},${Math.round(py * 10) / 10}`;
    })
    .join(' ');
}

export interface SparklineProps {
  /** `[x, y]` pairs in x order (a cumulative series: time, total). */
  points: readonly (readonly [number, number])[];
  /** Size and colour: the line is drawn in the text colour. */
  className?: string;
}

export function Sparkline({ points, className }: SparklineProps) {
  const line = sparklinePoints(points);
  if (!line) return null;
  return (
    <svg
      aria-hidden
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      preserveAspectRatio="none"
      className={cn('block w-full', className)}
    >
      <polyline
        points={line}
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

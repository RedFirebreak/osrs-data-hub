'use client';
/**
 * The number a Progress view leads with ("+1,265,900 XP"). When the range or measure changes it
 * counts from what it shows to the new amount, in step with the chart: a critically damped spring
 * (no overshoot), started from the value on screen, so a second change mid-count just redirects it.
 * With reduced motion, and on the first render, it is simply the amount.
 */
import type { MetricsMeasure } from '@hub/core';
import { useEffect, useRef, useState } from 'react';
import { formatAmount } from '@/components/metrics/format';
import { useReducedMotion } from '@/lib/use-reduced-motion';
import { cn } from '@/lib/utils';

/** Spring stiffness; with critical damping it settles in about 0.4 s, like the chart. */
const STIFFNESS = 260;
const DAMPING = 2 * Math.sqrt(STIFFNESS);

/** "+12,345 XP", "+1.2M gp", "+14 kills"; play time has no sign ("6h 12m"). */
export function headlineText(measure: MetricsMeasure, value: number): string {
  return `${measure === 'active' ? '' : '+'}${formatAmount(measure, Math.max(0, value))}`;
}

/** `target`, approached from the value last shown whenever it changes. */
function useSpringTo(target: number, animate: boolean): number {
  const [shown, setShown] = useState(target);
  const state = useRef({ value: target, velocity: 0 });
  useEffect(() => {
    const s = state.current;
    if (!animate) {
      // Nothing to move: the hook hands out the target itself (below).
      s.value = target;
      s.velocity = 0;
      return;
    }
    let frame = 0;
    let last = performance.now();
    const step = (now: number) => {
      const dt = Math.min(0.032, (now - last) / 1000);
      last = now;
      s.velocity += (STIFFNESS * (target - s.value) - DAMPING * s.velocity) * dt;
      s.value += s.velocity * dt;
      // Close enough that the next frames would not change a digit.
      if (Math.abs(target - s.value) < Math.max(0.5, Math.abs(target) * 0.0005)) {
        s.value = target;
        s.velocity = 0;
        setShown(target);
        return;
      }
      setShown(s.value);
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target, animate]);
  return animate ? shown : target;
}

export interface ProgressHeadlineProps {
  value: number;
  measure: MetricsMeasure;
  className?: string;
}

export function ProgressHeadline({ value, measure, className }: ProgressHeadlineProps) {
  const shown = useSpringTo(value, !useReducedMotion());
  return (
    <p
      className={cn(
        'text-4xl leading-none font-semibold tracking-tight tabular-nums sm:text-5xl',
        className,
      )}
    >
      {/* The final amount for assistive tech; the digits on the way there are for the eye. */}
      <span className="sr-only">{headlineText(measure, value)}</span>
      <span aria-hidden>{headlineText(measure, shown)}</span>
    </p>
  );
}

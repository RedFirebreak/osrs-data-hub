'use client';
/**
 * EChart, loaded lazily on the client only (next/dynamic with ssr: false, which Next allows in
 * client components only). Server rendering never imports echarts, and the chart code is fetched
 * after the page's own JavaScript; until then a skeleton of the chart's size is shown.
 *
 *   <LazyEChart option={option} label="…" className="h-64" />
 */
import dynamic from 'next/dynamic';
import { Skeleton } from '@/components/ui/skeleton';

export const LazyEChart = dynamic(() => import('./echart').then((m) => m.EChart), {
  ssr: false,
  loading: () => <ChartSkeleton />,
});

/** The placeholder while the chart code loads (and for charts whose data is loading). */
export function ChartSkeleton({ className }: { className?: string }) {
  return (
    <div role="status" aria-label="Loading chart" className={className ?? 'h-64 w-full'}>
      <Skeleton className="size-full rounded-lg" />
    </div>
  );
}

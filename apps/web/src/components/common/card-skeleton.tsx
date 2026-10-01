/**
 * A card while its content loads: the card's outline, a bar where its heading goes, then an optional
 * chart-sized block, `rows` bars and whatever else the card needs (children). Server- and
 * client-safe. The loading state's role and label belong to whoever shows the skeletons.
 *
 *   <CardSkeleton rows={6} />                                 // heading + six lines
 *   <CardSkeleton chart />                                    // heading + a chart
 *   <CardSkeleton rows={8} rowClassName="h-8 w-full" />       // taller rows (list items)
 *   <CardSkeleton headingClassName="h-6 w-1/2">…</CardSkeleton>
 */
import { Skeleton } from '@/components/ui/skeleton';

export interface CardSkeletonProps {
  /** Bars under the heading (default none). */
  rows?: number;
  /** A chart-sized block (h-64) above the rows. */
  chart?: boolean;
  /** Size of the heading bar (default h-5 w-32). */
  headingClassName?: string;
  /** Size of each row (default h-5 w-full). */
  rowClassName?: string;
  /** Rendered after the rows. */
  children?: React.ReactNode;
}

export function CardSkeleton({
  rows = 0,
  chart = false,
  headingClassName = 'h-5 w-32',
  rowClassName = 'h-5 w-full',
  children,
}: CardSkeletonProps) {
  return (
    <div className="flex flex-col gap-4 rounded-xl p-4 ring-1 ring-foreground/10">
      <Skeleton className={headingClassName} />
      {chart && <Skeleton className="h-64 w-full rounded-lg" />}
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className={rowClassName} />
      ))}
      {children}
    </div>
  );
}

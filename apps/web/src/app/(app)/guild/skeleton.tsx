/** The guild page's content while it loads (also the route's loading state). */
import { Skeleton } from '@/components/ui/skeleton';

function CardSkeleton({ rows }: { rows: number }) {
  return (
    <div className="flex flex-col gap-4 rounded-xl p-4 ring-1 ring-foreground/10">
      <Skeleton className="h-5 w-32" />
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-8 w-full" />
      ))}
    </div>
  );
}

export function GuildSkeleton() {
  return (
    <div
      className="grid items-start gap-6 lg:grid-cols-3"
      role="status"
      aria-label="Loading the guild"
    >
      <div className="flex flex-col gap-6 lg:col-span-2">
        <CardSkeleton rows={6} />
        <CardSkeleton rows={8} />
      </div>
      <CardSkeleton rows={8} />
    </div>
  );
}

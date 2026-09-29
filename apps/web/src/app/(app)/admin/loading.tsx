/** Any admin page while the server renders it (below the admin heading and tabs). */
import { Skeleton } from '@/components/ui/skeleton';

export default function AdminLoading() {
  return (
    <div className="flex flex-col gap-4" role="status" aria-label="Loading">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
      <div className="flex flex-col gap-3 rounded-xl p-4 ring-1 ring-foreground/10">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="flex items-center gap-3">
            <Skeleton className="size-6 shrink-0 rounded-full" />
            <Skeleton className="h-4 w-40" />
            <Skeleton className="ml-auto hidden h-4 w-24 sm:block" />
            <Skeleton className="h-4 w-16" />
          </div>
        ))}
      </div>
    </div>
  );
}

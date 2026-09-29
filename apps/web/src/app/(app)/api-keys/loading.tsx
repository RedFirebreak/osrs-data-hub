/** API keys while the server renders it. */
import { Skeleton } from '@/components/ui/skeleton';

export default function ApiKeysLoading() {
  return (
    <div
      className="mx-auto flex w-full max-w-4xl flex-col gap-6"
      role="status"
      aria-label="Loading your API keys"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-8 w-32" />
          <Skeleton className="h-4 w-80 max-w-full" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-8 w-32" />
          <Skeleton className="h-8 w-28" />
        </div>
      </div>
      <Skeleton className="h-24 w-full rounded-xl" />
      <Skeleton className="h-6 w-40" />
      {[0, 1].map((i) => (
        <div key={i} className="flex flex-col gap-4 rounded-xl p-4 ring-1 ring-foreground/10">
          <div className="flex items-center justify-between">
            <Skeleton className="h-6 w-40" />
            <Skeleton className="h-5 w-16 rounded-full" />
          </div>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {[0, 1, 2, 3].map((j) => (
              <div key={j} className="flex flex-col gap-1">
                <Skeleton className="h-3 w-16" />
                <Skeleton className="h-4 w-24" />
              </div>
            ))}
          </div>
          <div className="flex gap-1.5">
            <Skeleton className="h-5 w-14 rounded-full" />
            <Skeleton className="h-5 w-16 rounded-full" />
          </div>
          <Skeleton className="ml-auto h-7 w-24" />
        </div>
      ))}
    </div>
  );
}

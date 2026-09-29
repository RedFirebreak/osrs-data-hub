/** The wizard while the server renders it. */
import { Skeleton } from '@/components/ui/skeleton';

export default function OnboardingLoading() {
  return (
    <div
      className="mx-auto flex w-full max-w-3xl flex-col gap-6"
      role="status"
      aria-label="Loading the pairing wizard"
    >
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </div>
      <div className="grid grid-cols-4 gap-2 sm:gap-3">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex flex-col gap-2">
            <Skeleton className="h-1.5 rounded-full" />
            <Skeleton className="h-4 w-16 max-w-full" />
          </div>
        ))}
      </div>
      <div className="flex flex-col gap-4 rounded-xl p-4 ring-1 ring-foreground/10">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-6 w-56" />
        <Skeleton className="h-4 w-full max-w-md" />
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-5 w-full max-w-lg" />
        ))}
        <Skeleton className="h-8 w-full sm:max-w-80" />
        <Skeleton className="ml-auto h-9 w-48" />
      </div>
    </div>
  );
}

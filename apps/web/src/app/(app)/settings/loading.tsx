/** Settings while the server renders it. */
import { Skeleton } from '@/components/ui/skeleton';

export default function SettingsLoading() {
  return (
    <div
      className="mx-auto flex w-full max-w-3xl flex-col gap-6"
      role="status"
      aria-label="Loading settings"
    >
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-4 w-64" />
      </div>
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex flex-col gap-4 rounded-xl p-4 ring-1 ring-foreground/10">
          <Skeleton className="h-5 w-36" />
          <Skeleton className="h-4 w-full max-w-md" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-2/3" />
        </div>
      ))}
    </div>
  );
}

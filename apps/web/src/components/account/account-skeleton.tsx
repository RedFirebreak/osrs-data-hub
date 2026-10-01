/**
 * The account page while its data loads: the header and the section grid as skeletons. The page shows
 * it in a <Suspense> after its visibility check, not as the segment's loading.tsx, so an unknown or
 * invisible account still answers 404 (NEXT-14).
 */
import { CardSkeleton } from '@/components/shell/card-skeleton';
import { Skeleton } from '@/components/ui/skeleton';

export function AccountSkeleton() {
  return (
    <div className="flex flex-col gap-6" role="status" aria-label="Loading the account">
      <div className="flex flex-col gap-3">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-4 w-72" />
      </div>
      <div className="grid items-start gap-6 lg:grid-cols-3">
        <div className="flex flex-col gap-6 lg:col-span-2">
          <CardSkeleton rows={10} />
          <CardSkeleton chart />
          <CardSkeleton rows={4} />
        </div>
        <div className="flex flex-col gap-6">
          <CardSkeleton rows={3} />
          <CardSkeleton rows={6} />
          <CardSkeleton rows={6} />
        </div>
      </div>
    </div>
  );
}

/** The account page while the server renders it: the header and the section grid as skeletons. */
import { Skeleton } from '@/components/ui/skeleton';

function CardSkeleton({ rows, chart = false }: { rows: number; chart?: boolean }) {
  return (
    <div className="flex flex-col gap-4 rounded-xl p-4 ring-1 ring-foreground/10">
      <Skeleton className="h-5 w-32" />
      {chart && <Skeleton className="h-64 w-full rounded-lg" />}
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-5 w-full" />
      ))}
    </div>
  );
}

export default function AccountLoading() {
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
          <CardSkeleton rows={0} chart />
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

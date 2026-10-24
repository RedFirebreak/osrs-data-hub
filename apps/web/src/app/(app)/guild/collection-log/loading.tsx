/** The guild's collection log while the server renders it (instead of the guild page's skeleton). */
import { CardSkeleton } from '@/components/common/card-skeleton';
import { Skeleton } from '@/components/ui/skeleton';

export default function GuildCollectionLogLoading() {
  return (
    <div className="flex flex-col gap-6" role="status" aria-label="Loading the log">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-16" />
        <Skeleton className="h-9 w-56" />
      </div>
      <Skeleton className="h-9 w-full max-w-md" />
      <CardSkeleton rows={8} />
    </div>
  );
}

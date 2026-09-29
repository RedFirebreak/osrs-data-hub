/** The guild page while the server renders it. */
import { Skeleton } from '@/components/ui/skeleton';
import { GuildSkeleton } from './skeleton';

export default function GuildLoading() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-4 w-72" />
      </div>
      <GuildSkeleton />
    </div>
  );
}

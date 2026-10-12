/** Friends while the server renders it. */
import { Skeleton } from '@/components/ui/skeleton';

export default function FriendsLoading() {
  return (
    <div
      className="mx-auto flex w-full max-w-3xl flex-col gap-6"
      role="status"
      aria-label="Loading your friends"
    >
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
      <Skeleton className="h-48 w-full rounded-xl" />
      <Skeleton className="h-6 w-40" />
      <Skeleton className="h-40 w-full rounded-xl" />
    </div>
  );
}

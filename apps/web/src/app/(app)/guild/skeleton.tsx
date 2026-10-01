/** The guild page's content while it loads (also the route's loading state). */
import { CardSkeleton } from '@/components/common/card-skeleton';

const ROW = 'h-8 w-full';

export function GuildSkeleton() {
  return (
    <div
      className="grid items-start gap-6 lg:grid-cols-3"
      role="status"
      aria-label="Loading the guild"
    >
      <div className="flex flex-col gap-6 lg:col-span-2">
        <CardSkeleton rows={6} rowClassName={ROW} />
        <CardSkeleton rows={8} rowClassName={ROW} />
      </div>
      <CardSkeleton rows={8} rowClassName={ROW} />
    </div>
  );
}

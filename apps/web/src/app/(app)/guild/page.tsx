/**
 * The guild page (handoff §12): gains leaderboards (today / 7 days / 30 days, per skill), the
 * boss leaderboards (kills gained over 7 / 30 days, D-110), the activity feed of every account the
 * viewer may see (latest 50, "load more", live events prepended), and the members with their visible
 * accounts and online dots. "Today" starts at midnight in the
 * viewer's time zone (Settings). Everything comes from @hub/server getGuildOverview, which applies
 * the permission resolver per account (handoff §10).
 */
import { OVERALL, getConfig, sortSkillsForDisplay, type Viewer } from '@hub/core';
import { getDb } from '@hub/db';
import {
  GUILD_FEED_EVENTS,
  getBossLeaderboards,
  getGuildOverview,
  getUserSettings,
} from '@hub/server';
import type { Metadata } from 'next';
import { Suspense } from 'react';
import { SectionCard } from '@/components/common/section-card';
import { EventTimeline } from '@/components/events/event-timeline';
import { eventTypeOptions } from '@/components/events/event-types';
import { BossLeaderboards } from '@/components/guild/boss-leaderboards';
import { Leaderboards } from '@/components/guild/leaderboards';
import { MemberList } from '@/components/guild/member-list';
import { AutoRefresh } from '@/components/shell/auto-refresh';
import { PageHeader } from '@/components/shell/page-header';
import { requireUser } from '@/lib/session';
import { cn } from '@/lib/utils';
import { GuildSkeleton } from './skeleton';

export function generateMetadata(): Metadata {
  return { title: `Guild · ${getConfig().hubName}` };
}

export default async function GuildPage() {
  const { user, viewer } = await requireUser();
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Guild"
        description="Who is playing, what they found and who gained the most XP."
      />
      <Suspense fallback={<GuildSkeleton />}>
        <GuildContent userId={user.id} viewer={viewer} />
      </Suspense>
      <AutoRefresh />
    </div>
  );
}

async function GuildContent({ userId, viewer }: { userId: string; viewer: Viewer }) {
  const { db } = getDb();
  const { timezone } = await getUserSettings(db, userId);
  const renderedAt = new Date();
  const [overview, bossBoards] = await Promise.all([
    getGuildOverview(db, viewer, { now: renderedAt, timezone }),
    getBossLeaderboards(db, viewer, { now: renderedAt, timezone }),
  ]);
  const hasBossBoards = bossBoards.week.length > 0 || bossBoards.month.length > 0;
  const now = renderedAt.toISOString();
  const skills = sortSkillsForDisplay([
    ...new Set([
      OVERALL,
      ...Object.values(overview.leaderboards).flatMap((boards) => boards.map((b) => b.skill)),
    ]),
  ]);
  // One grid, so phones get Leaderboards, Members, Boss leaderboards, then the (long) Activity feed;
  // from lg on, Members is the right-hand column beside the others.
  return (
    <div className="grid items-start gap-6 lg:grid-cols-3">
      <SectionCard
        id="leaderboards"
        title="Leaderboards"
        description="XP gained, among the accounts whose stats you can see."
        className="lg:col-span-2"
      >
        <Leaderboards boards={overview.leaderboards} skills={skills} />
      </SectionCard>
      <SectionCard
        id="members"
        title="Members"
        description={
          overview.members.length === 0
            ? undefined
            : `${overview.members.length} ${overview.members.length === 1 ? 'member' : 'members'} with accounts you can see.`
        }
        className={cn(
          'lg:col-start-3 lg:row-start-1',
          hasBossBoards ? 'lg:row-span-3' : 'lg:row-span-2',
        )}
      >
        {overview.members.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No accounts are shared with you yet. Members appear here once their RuneLite reports an
            account and it is shared with the guild.
          </p>
        ) : (
          <MemberList members={overview.members} />
        )}
      </SectionCard>
      {hasBossBoards && (
        <SectionCard
          id="boss-leaderboards"
          title="Boss leaderboards"
          description="Kills gained, from the official hiscores, among the accounts whose hiscores you can see."
          className="lg:col-span-2 lg:row-start-2"
        >
          <BossLeaderboards boards={bossBoards} />
        </SectionCard>
      )}
      <SectionCard
        id="activity"
        title="Activity"
        description="Events from across the guild."
        className={cn('lg:col-span-2', hasBossBoards ? 'lg:row-start-3' : 'lg:row-start-2')}
      >
        <EventTimeline
          initial={overview.feed}
          guildFilter={overview.feedFilter}
          pageSize={GUILD_FEED_EVENTS}
          typeOptions={eventTypeOptions()}
          now={now}
          label="Guild activity"
          empty={
            <p className="py-4 text-sm text-muted-foreground">
              No events yet. Loot, level-ups and other events from the guild appear here as the
              players&apos; plugins send them.
            </p>
          }
        />
      </SectionCard>
    </div>
  );
}

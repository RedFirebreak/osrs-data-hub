/**
 * The account page (handoff §12): header (name, type, live presence, owner, previous names), then one
 * card per section. Each section follows the read model's three states (handoff §10, D-4): hidden
 * when the viewer may not see its category, a "Not shared" card when the plugin never sent it, or the
 * data (`dataSection` in components/common/section-card.tsx applies that rule). Sections backed by
 * a history (sessions, gear changes, wealth) and the sharing panel stream in behind skeletons.
 * notFound() when the account doesn't exist or isn't visible to the viewer, so the two can't be told
 * apart.
 *
 * The visibility check runs first, before anything streams, and the rest of the page loads inside a
 * <Suspense> with the page skeleton: a segment loading.tsx would start the response as 200 before
 * notFound(), leaving an unknown account a "soft 404" (NEXT-14).
 *
 * Live: presence follows the LiveProvider (AccountPresence), new events are prepended to the timeline,
 * and the server-rendered numbers refresh every minute (AutoRefresh).
 */
import { DAY_MS, formatGp, formatNumber, getConfig, itemsValue } from '@hub/core';
import type { Viewer } from '@hub/core';
import { getDb } from '@hub/db';
import {
  PAGE_EVENTS,
  getAccountPage,
  getEquipmentHistory,
  getSessions,
  getSharingSettings,
  getUserSettings,
  getWealthHistory,
  type AccountPage,
} from '@hub/server';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Suspense, cache } from 'react';
import { AccountHeader } from '@/components/account-page/account-header';
import { AccountSkeleton } from '@/components/account-page/account-skeleton';
import { ActivityContent } from '@/components/account-page/activity-section';
import { EquipmentGrid, EquipmentLog } from '@/components/account-page/equipment-content';
import { HiscoresContent, hiscoresDescription } from '@/components/account-page/hiscores-content';
import { InventoryContent } from '@/components/account-page/inventory-content';
import { LocationContent } from '@/components/account-page/location-content';
import { playtimeByDay } from '@/components/account-page/playtime';
import { SkillsTable } from '@/components/account-page/skills-table';
import { VitalsContent } from '@/components/account-page/vitals-content';
import { XpChartPanel } from '@/components/account-page/xp-chart-panel';
import { NotSharedBadge } from '@/components/accounts/not-shared-badge';
import { WealthChart } from '@/components/charts/wealth-chart';
import { CardSkeleton } from '@/components/common/card-skeleton';
import { SectionCard, dataSection } from '@/components/common/section-card';
import { EventTimeline } from '@/components/events/event-timeline';
import { eventTypeOptions } from '@/components/events/event-types';
import { AutoRefresh } from '@/components/shell/auto-refresh';
import { SharingPanel } from '@/components/sharing/sharing-panel';
import { Skeleton } from '@/components/ui/skeleton';
import { AccountTabs } from '@/components/metrics/metrics-panels';
import { requireUser } from '@/lib/session';
import { cn } from '@/lib/utils';
import { loadVisible } from './visible';

/** Days of play sessions behind the playtime chart and the sessions list. */
const ACTIVITY_DAYS = 30;
/** Days of gear changes and wealth shown. */
const HISTORY_DAYS = 90;

/** The page's data (inside the Suspense boundary). */
const loadAccount = cache(async (publicId: string) => {
  const { user, viewer } = await requireUser();
  const { db } = getDb();
  const { timezone } = await getUserSettings(db, user.id);
  const renderedAt = new Date();
  const page = await getAccountPage(db, viewer, publicId, { now: renderedAt, timezone });
  return { viewer, timezone, renderedAt, page };
});

export async function generateMetadata({
  params,
}: PageProps<'/accounts/[publicId]'>): Promise<Metadata> {
  const { publicId } = await params;
  const visible = await loadVisible(publicId);
  return { title: `${visible?.account.name ?? 'Account'} · ${getConfig().hubName}` };
}

export default async function AccountPageRoute({ params }: PageProps<'/accounts/[publicId]'>) {
  const { publicId } = await params;
  // See NEXT-14: before any Suspense boundary, so the answer is a real 404.
  if (!(await loadVisible(publicId))) notFound();
  return (
    <Suspense fallback={<AccountSkeleton />}>
      <AccountContent publicId={publicId} />
    </Suspense>
  );
}

async function AccountContent({ publicId }: { publicId: string }) {
  const { viewer, timezone, renderedAt, page } = await loadAccount(publicId);
  // Hidden since the check a moment ago (rare): the not-found UI, if no longer a 404 status.
  if (!page) notFound();
  const now = renderedAt.toISOString();
  // Without `activity` (presence hidden), skills, equipment and inventory carry only the day (D-50).
  const dayOnlyIn = page.presence.visible ? undefined : timezone;
  const ctx: SectionContext = { viewer, publicId, page, now, timezone, renderedAt, dayOnlyIn };

  const main = [
    skillsSection(ctx),
    xpSection(ctx),
    activitySection(ctx),
    eventsSection(ctx),
    hiscoresSection(ctx),
  ].filter(Boolean);
  const aside = [
    vitalsSection(ctx),
    locationSection(ctx),
    equipmentSection(ctx),
    inventorySection(ctx),
    wealthSection(ctx),
  ].filter(Boolean);

  return (
    <div className="flex flex-col gap-6">
      <AccountHeader
        account={page.account}
        presence={page.presence}
        now={now}
        timezone={timezone}
      />
      <AccountTabs publicId={publicId} active="overview" />
      {main.length === 0 && aside.length === 0 ? (
        <SectionCard
          title="Nothing else shared with you"
          description="The owner of this account doesn't share its stats, events or activity with you."
        />
      ) : (
        <div
          className={cn(
            'grid items-start gap-6',
            main.length > 0 && aside.length > 0 && 'lg:grid-cols-3',
            main.length === 0 && 'md:grid-cols-2',
          )}
        >
          {main.length > 0 && (
            <div className={cn('flex min-w-0 flex-col gap-6', aside.length > 0 && 'lg:col-span-2')}>
              {main}
            </div>
          )}
          {aside.length > 0 && main.length > 0 ? (
            <div className="flex min-w-0 flex-col gap-6">{aside}</div>
          ) : (
            aside
          )}
        </div>
      )}
      {/* getSharingSettings admits exactly these viewers; for anyone else a skeleton would flash
          and vanish on every visit. */}
      {(page.account.relation === 'owner' ||
        page.account.relation === 'contributor' ||
        page.account.canManage) && (
        <Suspense
          fallback={
            <CardSkeleton>
              <ContentSkeleton rows={6} />
            </CardSkeleton>
          }
        >
          <SharingSection viewer={viewer} publicId={publicId} account={page.account} now={now} />
        </Suspense>
      )}
      <AutoRefresh />
    </div>
  );
}

interface SectionContext {
  viewer: Viewer;
  publicId: string;
  page: AccountPage;
  now: string;
  timezone: string;
  renderedAt: Date;
  /** The viewer's time zone when section times are day-only (D-50), else undefined. */
  dayOnlyIn: string | undefined;
}

// --- Main column ---------------------------------------------------------------------------------

function skillsSection({ page, now, dayOnlyIn }: SectionContext) {
  return dataSection(page.skills, {
    id: 'skills',
    title: 'Skills',
    what: 'stats (skills and XP)',
    now,
    updatedDayIn: dayOnlyIn,
    description: (skills) => (
      <span>
        Total level{' '}
        <span className="font-medium text-foreground tabular-nums">
          {formatNumber(skills.totalLevel)}
        </span>{' '}
        · Overall XP{' '}
        <span className="font-medium text-foreground tabular-nums">
          {formatNumber(skills.overallXp)}
        </span>
      </span>
    ),
    contentClassName: 'px-0 sm:px-(--card-spacing)',
    content: (skills) => <SkillsTable rows={skills.rows} />,
  });
}

function xpSection({ page, publicId, timezone }: SectionContext) {
  const skills = page.skills;
  if (!skills.visible || !skills.shared) return null;
  return (
    <SectionCard
      key="xp"
      id="xp"
      title="XP history"
      description="XP of one skill over time; it only ever goes up."
    >
      <XpChartPanel
        publicId={publicId}
        skills={skills.data.rows.map((r) => r.skill)}
        firstSeen={page.account.firstSeen}
        timezone={timezone}
      />
    </SectionCard>
  );
}

function activitySection(ctx: SectionContext) {
  if (!ctx.page.presence.visible) return null;
  return (
    <SectionCard
      key="activity"
      id="activity"
      title="Sessions & playtime"
      description={`The last ${ACTIVITY_DAYS} days, in your time zone.`}
    >
      <Suspense fallback={<ContentSkeleton rows={5} chart />}>
        <ActivityLoader ctx={ctx} />
      </Suspense>
    </SectionCard>
  );
}

async function ActivityLoader({ ctx }: { ctx: SectionContext }) {
  const to = ctx.renderedAt;
  const sessions = await getSessions(getDb().db, ctx.viewer, ctx.publicId, {
    from: new Date(to.getTime() - ACTIVITY_DAYS * DAY_MS),
    to,
  });
  if (sessions === null) return null;
  const playtime = playtimeByDay(sessions, {
    now: to,
    days: ACTIVITY_DAYS,
    timezone: ctx.timezone,
  });
  return <ActivityContent sessions={sessions} playtime={playtime} timezone={ctx.timezone} />;
}

function eventsSection({ page, publicId, now }: SectionContext) {
  const events = page.recentEvents;
  if (!events.visible) return null;
  return (
    <SectionCard
      key="events"
      id="events"
      title="Events"
      description="Loot, level-ups, deaths and more, newest first."
      action={events.shared ? undefined : <NotSharedBadge what="events" />}
    >
      <EventTimeline
        initial={events.shared ? events.data : []}
        pageSize={PAGE_EVENTS}
        accountPublicId={publicId}
        typeOptions={eventTypeOptions()}
        now={now}
        linkAccounts={false}
        label={`Events of ${page.account.name}`}
        empty={
          <p className="py-4 text-sm text-muted-foreground">
            {events.shared
              ? 'No events yet.'
              : "No events have arrived for this account. The player's plugin settings decide which events are sent."}{' '}
            New events appear here as they happen.
          </p>
        }
      />
    </SectionCard>
  );
}

function hiscoresSection({ page, now, dayOnlyIn }: SectionContext) {
  const hiscores = page.hiscores;
  if (!hiscores.visible) return null;
  const view = hiscores.data;
  return (
    <SectionCard
      key="hiscores"
      id="hiscores"
      title="Hiscores"
      description={hiscoresDescription(view)}
      updatedAt={view.fetchedAt}
      now={now}
      updatedDayIn={dayOnlyIn}
    >
      <HiscoresContent view={view} />
    </SectionCard>
  );
}

// --- Side column ---------------------------------------------------------------------------------

function vitalsSection({ page, now }: SectionContext) {
  return dataSection(page.vitals, {
    id: 'vitals',
    title: 'Vitals',
    what: 'HP, prayer or the spellbook',
    now,
    content: (vitals) => <VitalsContent vitals={vitals} />,
  });
}

function locationSection({ page, now }: SectionContext) {
  return dataSection(page.location, {
    id: 'location',
    title: 'Location',
    what: 'the location',
    now,
    content: (location) => <LocationContent location={location} />,
  });
}

function equipmentSection(ctx: SectionContext) {
  return dataSection(ctx.page.equipment, {
    id: 'equipment',
    title: 'Equipment',
    what: 'the equipment',
    now: ctx.now,
    updatedDayIn: ctx.dayOnlyIn,
    content: (equipment) => (
      <div className="flex flex-col gap-4">
        <EquipmentGrid items={equipment.items} />
        <div>
          <h3 className="mb-1 text-xs font-medium text-muted-foreground">Changes</h3>
          <Suspense fallback={<ContentSkeleton rows={3} />}>
            <EquipmentLogLoader ctx={ctx} />
          </Suspense>
        </div>
      </div>
    ),
  });
}

async function EquipmentLogLoader({ ctx }: { ctx: SectionContext }) {
  const to = ctx.renderedAt;
  const changes = await getEquipmentHistory(getDb().db, ctx.viewer, ctx.publicId, {
    from: new Date(to.getTime() - HISTORY_DAYS * DAY_MS),
    to,
  });
  if (changes === null) return null;
  return <EquipmentLog changes={changes} timezone={ctx.timezone} />;
}

function inventorySection({ page, now, dayOnlyIn }: SectionContext) {
  const gear =
    page.equipment.visible && page.equipment.shared
      ? (itemsValue(page.equipment.data.items) ?? 0)
      : null;
  return dataSection(page.inventory, {
    id: 'inventory',
    title: 'Inventory',
    what: 'the inventory',
    now,
    updatedDayIn: dayOnlyIn,
    description: (inventory) => (
      <span>
        Worth{' '}
        <span className="font-medium text-foreground tabular-nums">
          {formatGp(inventory.value)} gp
        </span>
        {gear !== null && (
          <>
            {' '}
            · carried with gear{' '}
            <span className="font-medium text-foreground tabular-nums">
              {formatGp(inventory.value + gear)} gp
            </span>
          </>
        )}
      </span>
    ),
    content: (inventory) => <InventoryContent items={inventory.items} />,
  });
}

function wealthSection(ctx: SectionContext) {
  if (!ctx.page.inventory.visible) return null;
  return (
    <Suspense
      key="wealth"
      fallback={
        <CardSkeleton>
          <ContentSkeleton rows={0} chart />
        </CardSkeleton>
      }
    >
      <WealthLoader ctx={ctx} />
    </Suspense>
  );
}

async function WealthLoader({ ctx }: { ctx: SectionContext }) {
  const to = ctx.renderedAt;
  const days = await getWealthHistory(getDb().db, ctx.viewer, ctx.publicId, {
    from: new Date(to.getTime() - HISTORY_DAYS * DAY_MS),
    to,
  });
  if (days === null) return null;
  const inventoryShared = ctx.page.inventory.visible && ctx.page.inventory.shared;
  // Nothing to chart and the inventory card already says it isn't sent.
  if (days.length === 0 && !inventoryShared) return null;
  return (
    <SectionCard
      id="wealth"
      title="Wealth"
      description={`Carried value (inventory and gear) per day, last ${HISTORY_DAYS} days.`}
    >
      {days.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No wealth history yet. It builds up day by day while the plugin sends the inventory.
        </p>
      ) : (
        <WealthChart days={days} />
      )}
    </SectionCard>
  );
}

// --- Sharing -------------------------------------------------------------------------------------

async function SharingSection({
  viewer,
  publicId,
  account,
  now,
}: {
  viewer: Viewer;
  publicId: string;
  account: AccountPage['account'];
  now: string;
}) {
  const settings = await getSharingSettings(getDb().db, viewer, publicId);
  if (!settings) return null;
  return (
    <SectionCard
      id="sharing"
      title="Sharing"
      description={
        settings.canManage
          ? 'Choose who in the guild sees each part of this account.'
          : 'Who in the guild sees each part of this account.'
      }
    >
      <SharingPanel
        // A new owner (transfer, claim) remounts the panel with the refreshed settings.
        key={`${account.owner?.userId ?? 'none'}:${settings.canManage}`}
        publicId={publicId}
        initial={settings}
        hasOwner={account.owner !== null}
        relation={account.relation}
        now={now}
      />
    </SectionCard>
  );
}

// --- Skeletons -----------------------------------------------------------------------------------

function ContentSkeleton({ rows, chart = false }: { rows: number; chart?: boolean }) {
  return (
    <div className="flex flex-col gap-3" role="status" aria-label="Loading">
      {chart && <Skeleton className="h-64 w-full rounded-lg" />}
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-5 w-full" />
      ))}
    </div>
  );
}

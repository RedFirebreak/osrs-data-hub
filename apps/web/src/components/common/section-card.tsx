/**
 * The frame of every section on the account and guild pages: a card with the section's heading
 * (h2), an optional badge or action, and when the hub last received the data. Server- and
 * client-safe.
 *
 *   <SectionCard title="Inventory" updatedAt={section.updatedAt} now={now}>…</SectionCard>
 *   <NotSharedCard title="Inventory" what="the inventory" />   // visible, never sent (D-4)
 *
 * Sections the viewer may not see are not rendered at all (handoff §10); only a section the viewer
 * may see but the plugin never sent gets the "Not shared" card. `dataSection` applies that rule to a
 * read model's Section, so a new section of the account page is one call:
 *
 *   dataSection(page.vitals, {
 *     id: 'vitals', title: 'Vitals', what: 'HP, prayer or the spellbook', now,
 *     content: (vitals) => <VitalsContent vitals={vitals} />,
 *   })
 */
import type { Section } from '@hub/server';
import { NotSharedBadge } from '@/components/accounts/not-shared-badge';
import { RelativeTime } from '@/components/time/relative-time';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { dayOnlyLabel } from '@/lib/dates';
import { cn } from '@/lib/utils';

export interface SectionCardProps {
  title: string;
  /** Anchor id (also used for aria-labelledby). */
  id?: string;
  description?: React.ReactNode;
  /** When the hub last received the section (ISO); shown as "Updated 3 min ago". */
  updatedAt?: string | null;
  /** Server render time (ISO), for the relative time. */
  now?: string;
  /**
   * `updatedAt` carries only the day, in this time zone (the viewer's): the read model withholds the
   * time from viewers without the `activity` category (D-50), so it is shown as "Updated today",
   * "yesterday" or a date, never as "9 h ago".
   */
  updatedDayIn?: string;
  /** Top-right slot (a badge, a small control). */
  action?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
  contentClassName?: string;
}

export function SectionCard({
  title,
  id,
  description,
  updatedAt,
  now,
  updatedDayIn,
  action,
  children,
  className,
  contentClassName,
}: SectionCardProps) {
  const headingId = id ? `${id}-heading` : undefined;
  return (
    <Card
      id={id}
      aria-labelledby={headingId}
      className={cn('min-w-0 scroll-mt-20', className)}
      role={id ? 'region' : undefined}
    >
      <CardHeader>
        <CardTitle>
          <h2 id={headingId} className="text-base font-semibold">
            {title}
          </h2>
        </CardTitle>
        {/* The description runs under the badge too (the action sits in the title's row only), so
            a "Not shared" explanation doesn't wrap into a narrow column beside it. */}
        {(description || updatedAt) && (
          <CardDescription className="col-span-full flex flex-wrap items-center gap-x-2 gap-y-1">
            {description}
            {updatedAt && (
              <span className="text-xs">
                {updatedDayIn === undefined ? (
                  <RelativeTime date={updatedAt} now={now} prefix="Updated" />
                ) : (
                  <UpdatedDay at={updatedAt} now={now} timezone={updatedDayIn} />
                )}
              </span>
            )}
          </CardDescription>
        )}
        {action && <CardAction className="row-span-1">{action}</CardAction>}
      </CardHeader>
      {children !== undefined && (
        <CardContent className={cn('min-w-0', contentClassName)}>{children}</CardContent>
      )}
    </Card>
  );
}

/** "Updated today" for a day-only stamp (see SectionCardProps.updatedDayIn). */
function UpdatedDay({ at, now, timezone }: { at: string; now?: string; timezone: string }) {
  const label = dayOnlyLabel(at, now ?? new Date(), timezone);
  if (!label) return null;
  return <time dateTime={label.day}>Updated {label.text}</time>;
}

export interface NotSharedCardProps {
  title: string;
  id?: string;
  /** What isn't sent, for the badge's explanation ("the inventory"). */
  what: string;
  className?: string;
}

/** A section the viewer may see but the player's plugin doesn't send (handoff §10, D-4). */
export function NotSharedCard({ title, id, what, className }: NotSharedCardProps) {
  return (
    <SectionCard
      title={title}
      id={id}
      className={className}
      action={<NotSharedBadge what={what} />}
      description={`The player's plugin doesn't send ${what}; nothing is stored or shown.`}
    />
  );
}

export interface DataSectionOptions<T> {
  /** Anchor id; also the element's key. */
  id: string;
  title: string;
  /** What isn't sent, for the "Not shared" card ("the inventory"). */
  what: string;
  /** Server render time (ISO), for "Updated 3 min ago". */
  now: string;
  /** The section's times are day-only, in this time zone (D-50; SectionCardProps.updatedDayIn). */
  updatedDayIn?: string;
  description?: (data: T) => React.ReactNode;
  contentClassName?: string;
  /** The card's content, from the section's data. */
  content: (data: T) => React.ReactNode;
}

/**
 * One section of the account page from the read model's `Section`, in its three states (handoff §10,
 * D-4): null when the viewer may not see it (nothing is rendered), the "Not shared" card when the
 * plugin never sent it, else the card with its data and when the hub last received it.
 *
 * A function rather than a component: the page lays out its columns by which sections exist, and a
 * component would always be an element.
 */
export function dataSection<T>(
  section: Section<T>,
  {
    id,
    title,
    what,
    now,
    updatedDayIn,
    description,
    contentClassName,
    content,
  }: DataSectionOptions<T>,
): React.ReactElement | null {
  if (!section.visible) return null;
  if (!section.shared) return <NotSharedCard key={id} id={id} title={title} what={what} />;
  return (
    <SectionCard
      key={id}
      id={id}
      title={title}
      updatedAt={section.updatedAt}
      now={now}
      updatedDayIn={updatedDayIn}
      description={description?.(section.data)}
      contentClassName={contentClassName}
    >
      {content(section.data)}
    </SectionCard>
  );
}

/**
 * Icons for events. @hub/core describeEvent (and so every FeedEvent) carries an icon *hint*
 * (EventIconHint: 'gift', 'skull', 'trending-up', …), which maps to a lucide icon and a tint here;
 * unknown hints fall back to the bell. GameOrEventIcon shows the event's game icon instead when it
 * has one (the item it names, else its skill; D-95), with the lucide icon as the fallback. Server-
 * and client-safe (no hooks here; the game icon is a client leaf).
 *
 *   <EventIcon icon={event.icon} className="size-4" />      // the bare lucide icon
 *   <GameOrEventIcon icon={event.icon} game={event} />      // the game icon, else that (toasts)
 *   <EventIconBadge icon={event.icon} game={event} />       // the same in a tinted circle (feeds)
 */
import { UNKNOWN_EVENT_ICON, type EventIconHint } from '@hub/core';
import {
  BellIcon,
  BookOpenIcon,
  GiftIcon,
  MapIcon,
  SkullIcon,
  SparklesIcon,
  SwordsIcon,
  TrendingUpIcon,
  type LucideProps,
} from 'lucide-react';
import { EventGameIcon } from '@/components/icons/osrs-icon';
import type { EventIconSource } from '@/lib/osrs-icons';
import { cn } from '@/lib/utils';

/** Tint per hint for EventIconBadge (light and dark). */
const TONES: Readonly<Record<EventIconHint, string>> = {
  gift: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  skull: 'bg-red-500/15 text-red-700 dark:text-red-300',
  'trending-up': 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  book: 'bg-violet-500/15 text-violet-700 dark:text-violet-300',
  swords: 'bg-orange-500/15 text-orange-700 dark:text-orange-300',
  map: 'bg-sky-500/15 text-sky-700 dark:text-sky-300',
  sparkles: 'bg-fuchsia-500/15 text-fuchsia-700 dark:text-fuchsia-300',
  bell: 'bg-muted text-muted-foreground',
};

/** A FeedEvent's hint is a string off the wire: one this build doesn't draw is the bell. */
function knownHint(icon: string): EventIconHint {
  return Object.hasOwn(TONES, icon) ? (icon as EventIconHint) : UNKNOWN_EVENT_ICON;
}

export interface EventIconProps extends LucideProps {
  /** describeEvent's icon hint (FeedEvent.icon). */
  icon: string;
}

/** The event's lucide icon; decorative (aria-hidden) unless you pass an aria-label. */
export function EventIcon({ icon, ...rest }: EventIconProps): React.JSX.Element {
  const props: LucideProps = { 'aria-hidden': rest['aria-label'] ? undefined : true, ...rest };
  // One element per hint (not a component looked up at render time: react-hooks/static-components).
  // No default, and the return type is spelled out, so a hint added to EventIconHint doesn't compile
  // until it has an icon here (and a tint in TONES).
  switch (knownHint(icon)) {
    case 'gift':
      return <GiftIcon {...props} />;
    case 'skull':
      return <SkullIcon {...props} />;
    case 'trending-up':
      return <TrendingUpIcon {...props} />;
    case 'book':
      return <BookOpenIcon {...props} />;
    case 'swords':
      return <SwordsIcon {...props} />;
    case 'map':
      return <MapIcon {...props} />;
    case 'sparkles':
      return <SparklesIcon {...props} />;
    case 'bell':
      return <BellIcon {...props} />;
  }
}

export interface GameOrEventIconProps {
  /** describeEvent's icon hint (FeedEvent.icon): the lucide icon shown when there is no game icon. */
  icon: string;
  /** The event's item and skill (a FeedEvent), which pick its game icon. */
  game: EventIconSource;
  /** Sizes the game icon (size-5 by default); the lucide icon is size-4 either way. */
  className?: string;
}

/**
 * The event's game icon (D-95), with its lucide icon as the fallback. The game icon needs an
 * IconConfigProvider above it; outside one this is the lucide icon.
 */
export function GameOrEventIcon({ icon, game, className }: GameOrEventIconProps) {
  return (
    <EventGameIcon
      event={game}
      className={className}
      fallback={<EventIcon icon={icon} className="size-4" />}
    />
  );
}

export interface EventIconBadgeProps {
  icon: string;
  /** Screen-reader text for the icon, e.g. the event's title ("Loot"). */
  label?: string;
  /** The event's item and skill (a FeedEvent): its game icon replaces the lucide one when it has one. */
  game: EventIconSource;
  className?: string;
}

/** The icon in a tinted circle, sized for feed rows (size-8; pass className to change). */
export function EventIconBadge({ icon, label, game, className }: EventIconBadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex size-8 shrink-0 items-center justify-center rounded-full',
        TONES[knownHint(icon)],
        className,
      )}
    >
      <GameOrEventIcon icon={icon} game={game} className="size-6" />
      {label && <span className="sr-only">{label}</span>}
    </span>
  );
}

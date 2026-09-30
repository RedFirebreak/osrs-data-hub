/**
 * Icons for events. @hub/core describeEvent (and so every FeedEvent) carries an icon *hint* —
 * 'gift' | 'skull' | 'trending-up' | 'book' | 'swords' | 'map' | 'sparkles' | 'bell' — which maps to
 * a lucide icon here; unknown hints fall back to the bell. EventIconBadge shows the event's game icon
 * instead when it has one (the item it names, else its skill; D-95), with the lucide icon as the
 * fallback. Server- and client-safe (no hooks here; the game icon is a client leaf).
 *
 *   <EventIcon icon={event.icon} className="size-4" />      // the bare icon
 *   <EventIconBadge icon={event.icon} game={event} />       // in a tinted circle (feeds)
 */
import {
  BellIcon,
  BookOpenIcon,
  GiftIcon,
  MapIcon,
  SkullIcon,
  SparklesIcon,
  SwordsIcon,
  TrendingUpIcon,
  type LucideIcon,
  type LucideProps,
} from 'lucide-react';
import { EventGameIcon } from '@/components/icons/osrs-icon';
import type { EventIconSource } from '@/lib/osrs-icons';
import { cn } from '@/lib/utils';

const ICONS: Readonly<Record<string, LucideIcon>> = {
  gift: GiftIcon,
  skull: SkullIcon,
  'trending-up': TrendingUpIcon,
  book: BookOpenIcon,
  swords: SwordsIcon,
  map: MapIcon,
  sparkles: SparklesIcon,
  bell: BellIcon,
};

/** Tint per hint for EventIconBadge (light and dark). */
const TONES: Readonly<Record<string, string>> = {
  gift: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  skull: 'bg-red-500/15 text-red-700 dark:text-red-300',
  'trending-up': 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  book: 'bg-violet-500/15 text-violet-700 dark:text-violet-300',
  swords: 'bg-orange-500/15 text-orange-700 dark:text-orange-300',
  map: 'bg-sky-500/15 text-sky-700 dark:text-sky-300',
  sparkles: 'bg-fuchsia-500/15 text-fuchsia-700 dark:text-fuchsia-300',
  bell: 'bg-muted text-muted-foreground',
};

/** The lucide icon component for a describeEvent icon hint (BellIcon when unknown). */
export function eventIconFor(hint: string): LucideIcon {
  return (Object.hasOwn(ICONS, hint) ? ICONS[hint] : undefined) ?? BellIcon;
}

export interface EventIconProps extends LucideProps {
  /** describeEvent's icon hint (FeedEvent.icon). */
  icon: string;
}

/** The event's icon; decorative (aria-hidden) unless you pass an aria-label. */
export function EventIcon({ icon, ...rest }: EventIconProps) {
  const props: LucideProps = { 'aria-hidden': rest['aria-label'] ? undefined : true, ...rest };
  // One element per hint (not a component looked up at render time: react-hooks/static-components).
  switch (icon) {
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
    default:
      return <BellIcon {...props} />;
  }
}

export interface EventIconBadgeProps {
  icon: string;
  /** Screen-reader text for the icon, e.g. the event's title ("Loot"). */
  label?: string;
  /** The event's item and skill (a FeedEvent): its game icon replaces the lucide one when it has one. */
  game?: EventIconSource;
  className?: string;
}

/** The icon in a tinted circle, sized for feed rows (size-8; pass className to change). */
export function EventIconBadge({ icon, label, game, className }: EventIconBadgeProps) {
  const tone = (Object.hasOwn(TONES, icon) ? TONES[icon] : undefined) ?? TONES.bell;
  return (
    <span
      className={cn(
        'inline-flex size-8 shrink-0 items-center justify-center rounded-full',
        tone,
        className,
      )}
    >
      {game ? (
        <EventGameIcon
          event={game}
          className="size-6"
          fallback={<EventIcon icon={icon} className="size-4" />}
        />
      ) : (
        <EventIcon icon={icon} className="size-4" />
      )}
      {label && <span className="sr-only">{label}</span>}
    </span>
  );
}

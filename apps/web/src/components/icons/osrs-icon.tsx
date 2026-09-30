'use client';
/**
 * OSRS game icons from the icon CDN (D-95): items (quantity-aware, so a pile of coins looks like
 * one), skills and empty equipment slots. Each renders its `fallback` instead when there is no icon:
 * icons are off (OSRS_ICONS_URL empty, or outside IconConfigProvider), the value has no icon URL
 * (Overall), or the image failed to load (the CDN answers 404 for ids without a picture). So pass as
 * fallback whatever the UI showed before icons, and keep the text accessible either way.
 *
 * Plain <img> rather than next/image: the files are already sized and cached by the CDN, and the
 * optimizer would proxy a third-party origin through the hub.
 *
 *   <ItemIcon itemId={995} quantity={250} fallback={<span>Coins</span>} />
 *   <SkillIcon skill="Attack" />
 *   <SlotIcon slot="AMULET" fallback={<span>Neck</span>} />
 */
import { useCallback, useState } from 'react';
import {
  eventIconUrl,
  itemIconUrl,
  skillIconUrl,
  slotIconUrl,
  type EventIconSource,
} from '@/lib/osrs-icons';
import { cn } from '@/lib/utils';
import { useIconConfig } from './icon-config-provider';

export interface OsrsImageProps {
  /** The icon URL; null = no icon (render the fallback). */
  src: string | null;
  /** CSS size of the box. */
  width: number;
  height: number;
  /** Empty (decorative) by default: the text beside or behind the icon names it. */
  alt?: string;
  /** Crisp pixels for a sprite drawn larger than its file (the skill and slot sprites). */
  pixelated?: boolean;
  className?: string;
  /** Shown when there is no icon or it failed to load. */
  fallback?: React.ReactNode;
}

/** One CDN image with a fallback for "no icon" (see the file comment). */
export function OsrsImage({
  src,
  width,
  height,
  alt = '',
  pixelated = false,
  className,
  fallback = null,
}: OsrsImageProps) {
  // The URL that failed, so a new src (another quantity) gets its own try.
  const [failed, setFailed] = useState<string | null>(null);
  // A server-rendered <img> can fail before hydration, while React isn't listening for its error
  // event yet. A broken image is complete with no natural width; decode() then tells a real failure
  // from an image that simply hasn't started loading (lazy), without trusting `complete` alone.
  const checkEarlyFailure = useCallback(
    (img: HTMLImageElement | null) => {
      if (!img || !src || !img.complete || img.naturalWidth > 0) return;
      img.decode().catch(() => setFailed(src));
    },
    [src],
  );
  if (!src || failed === src) return <>{fallback}</>;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- see the file comment
    <img
      ref={checkEarlyFailure}
      src={src}
      width={width}
      height={height}
      alt={alt}
      loading="lazy"
      decoding="async"
      draggable={false}
      onError={() => setFailed(src)}
      className={cn('select-none', pixelated && '[image-rendering:pixelated]', className)}
    />
  );
}

type IconProps = Omit<OsrsImageProps, 'src' | 'width' | 'height'> & {
  /**
   * While icons are on, leave an empty box of the icon's size when this value has none (Overall, a
   * 404), so rows of a list stay aligned. With icons off the fallback renders as usual.
   */
  holdSpace?: boolean;
};

/** The fallback, or an empty box of the icon's size (holdSpace while icons are on). */
function fallbackFor(
  base: string | null,
  { holdSpace, fallback }: Pick<IconProps, 'holdSpace' | 'fallback'>,
  className: string,
): React.ReactNode {
  return holdSpace && base ? (
    <span aria-hidden className={cn('inline-block', className)} />
  ) : (
    fallback
  );
}

/**
 * An item at its in-game size (36×32 CSS px; the files are 2× for sharp HiDPI). `quantity` picks the
 * stack picture (coins, arrows, runes …) from the CDN's stack tables.
 */
export function ItemIcon({
  itemId,
  quantity = 1,
  className,
  holdSpace,
  fallback,
  ...rest
}: IconProps & { itemId: number | null | undefined; quantity?: number }) {
  const { base, stacks } = useIconConfig();
  const box = cn('h-8 w-9 shrink-0 object-contain', className);
  return (
    <OsrsImage
      src={itemIconUrl(base, stacks, itemId, quantity)}
      width={36}
      height={32}
      className={box}
      fallback={fallbackFor(base, { holdSpace, fallback }, box)}
      {...rest}
    />
  );
}

/**
 * A skill's icon ("Attack"; none for Overall) in a 20 px square: the sprites are 13–25 px and not
 * square, so the box keeps rows aligned; a sprite is only ever scaled down (object-scale-down), never
 * blurred up. Size it with className (`size-*`).
 */
export function SkillIcon({
  skill,
  className,
  holdSpace,
  fallback,
  ...rest
}: IconProps & { skill: string | null | undefined }) {
  const { base } = useIconConfig();
  const box = cn('size-5 shrink-0 object-scale-down', className);
  return (
    <OsrsImage
      src={skillIconUrl(base, skill)}
      width={20}
      height={20}
      className={box}
      fallback={fallbackFor(base, { holdSpace, fallback }, box)}
      {...rest}
    />
  );
}

/**
 * The empty-slot silhouette for a RuneLite EquipmentInventorySlot ("HEAD", "AMULET", …), at its
 * native size (up to about 31 px) centred in a 32 px square.
 */
export function SlotIcon({
  slot,
  className,
  holdSpace,
  fallback,
  ...rest
}: IconProps & { slot: string }) {
  const { base } = useIconConfig();
  const box = cn('size-8 shrink-0 object-none', className);
  return (
    <OsrsImage
      src={slotIconUrl(base, slot)}
      width={32}
      height={32}
      className={box}
      fallback={fallbackFor(base, { holdSpace, fallback }, box)}
      {...rest}
    />
  );
}

/**
 * An event's game icon (eventIconUrl: the item it names, else its skill) in a 20 px square, scaled
 * down to fit, never up; the fallback (the event's lucide icon) otherwise. Size it with className.
 */
export function EventGameIcon({
  event,
  className,
  holdSpace,
  fallback,
  ...rest
}: IconProps & { event: EventIconSource }) {
  const { base, stacks } = useIconConfig();
  const box = cn('size-5 shrink-0 object-scale-down', className);
  return (
    <OsrsImage
      src={eventIconUrl(base, stacks, event)}
      width={20}
      height={20}
      className={box}
      fallback={fallbackFor(base, { holdSpace, fallback }, box)}
      {...rest}
    />
  );
}

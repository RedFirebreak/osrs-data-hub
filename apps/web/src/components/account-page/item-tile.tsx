/**
 * One item square (inventory slot or worn-equipment slot): the item's icon from the icon CDN (D-95;
 * the stack picture for its quantity, e.g. a pile of coins) with its stack size overlaid in the
 * in-game notation and colours (yellow, white from 100K, green from 10M), and the full details for
 * screen readers and in the tooltip title. Without an icon (icons off, or none for the id) the item's
 * name is shown instead. An empty equipment slot shows the slot's silhouette, or its name. Server-
 * and client-safe (the icons are client leaves).
 */
import { formatGp, formatNumber, type ItemData } from '@hub/core';
import { ItemIcon, SlotIcon } from '@/components/icons/osrs-icon';
import { cn } from '@/lib/utils';
import { entryValue, itemName, stackLabel, stackTone } from './items';

export function ItemTile({
  item,
  placeholder,
  slot,
  className,
}: {
  item: ItemData | null;
  /** Shown in an empty tile (a slot name), muted. */
  placeholder?: string;
  /** RuneLite EquipmentInventorySlot of an equipment tile: an empty one shows its silhouette. */
  slot?: string;
  className?: string;
}) {
  if (!item) {
    const label = placeholder ? <span aria-hidden>{placeholder}</span> : null;
    return (
      <div
        title={placeholder}
        className={cn(
          'flex aspect-square min-w-0 items-center justify-center rounded-md border border-dashed p-1 text-center text-[10px] leading-tight text-muted-foreground',
          className,
        )}
      >
        {slot ? <SlotIcon slot={slot} className="opacity-70" fallback={label} /> : label}
        <span className="sr-only">{placeholder ? `${placeholder}: empty` : 'Empty slot'}</span>
      </div>
    );
  }
  const name = itemName(item);
  const quantity = Number.isFinite(item.quantity) ? item.quantity : 0;
  const value = entryValue(item);
  const details = `${quantity > 1 ? `${formatNumber(quantity)} × ` : ''}${name}${
    value > 0 ? `, ${formatGp(value)} gp` : ''
  }`;
  return (
    <div
      title={details}
      className={cn(
        'relative flex aspect-square min-w-0 flex-col justify-end overflow-hidden rounded-md border bg-muted/40 p-1',
        className,
      )}
    >
      {quantity > 1 && (
        <span
          aria-hidden
          className={cn(
            'absolute top-0.5 left-1 z-10 text-[10px] font-semibold tabular-nums',
            stackTone(quantity),
          )}
        >
          {stackLabel(quantity)}
        </span>
      )}
      <ItemIcon
        itemId={item.id}
        quantity={Math.max(1, quantity)}
        // m-auto centres the icon in the column; the name fallback stays at the bottom.
        className="m-auto"
        fallback={
          <span aria-hidden className="line-clamp-2 text-[10px] leading-tight break-words">
            {name}
          </span>
        }
      />
      <span className="sr-only">{details}</span>
    </div>
  );
}

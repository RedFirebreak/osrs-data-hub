/**
 * One item square (inventory slot or worn-equipment slot): the item's name, its stack size in the
 * in-game notation and colours (yellow, white from 100K, green from 10M), and the full details for
 * screen readers and in the tooltip title. No item images: the hub has no icon source. Server- and
 * client-safe.
 */
import { formatGp, formatNumber, type ItemData } from '@hub/core';
import { cn } from '@/lib/utils';
import { entryValue, itemName, stackLabel } from './items';

function stackTone(quantity: number): string {
  if (quantity >= 10_000_000) return 'text-emerald-700 dark:text-emerald-400';
  if (quantity >= 100_000) return 'text-foreground';
  return 'text-amber-700 dark:text-amber-300';
}

export function ItemTile({
  item,
  placeholder,
  className,
}: {
  item: ItemData | null;
  /** Shown in an empty tile (a slot name), muted. */
  placeholder?: string;
  className?: string;
}) {
  if (!item) {
    return (
      <div
        className={cn(
          'flex aspect-square min-w-0 items-center justify-center rounded-md border border-dashed p-1 text-center text-[10px] leading-tight text-muted-foreground/70',
          className,
        )}
      >
        {placeholder ? (
          <span>
            {placeholder}
            <span className="sr-only">: empty</span>
          </span>
        ) : (
          <span className="sr-only">Empty slot</span>
        )}
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
          className={cn('absolute top-0.5 left-1 text-[10px] font-semibold', stackTone(quantity))}
        >
          {stackLabel(quantity)}
        </span>
      )}
      <span aria-hidden className="line-clamp-2 text-[10px] leading-tight break-words">
        {name}
      </span>
      <span className="sr-only">{details}</span>
    </div>
  );
}

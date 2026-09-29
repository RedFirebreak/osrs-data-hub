/**
 * The inventory (the `inventory` category): a 28-slot grid (items in the order the plugin sent them;
 * it sends occupied slots only, PLUGIN-11), the same items merged into stacks by value, and the
 * carried value. Server component.
 */
import { formatGp, formatNumber, type ItemData } from '@hub/core';
import { ItemTile } from './item-tile';
import { inventorySlots, mergeStacks } from './items';

/** Stacks listed next to the grid. */
export const TOP_STACKS = 8;

export function InventoryContent({ items }: { items: readonly ItemData[] }) {
  if (items.length === 0) {
    return <p className="text-sm text-muted-foreground">The inventory is empty.</p>;
  }
  const stacks = mergeStacks(items);
  return (
    <div className="flex flex-col gap-4">
      <div role="list" aria-label="Inventory slots" className="grid grid-cols-4 gap-1.5">
        {inventorySlots(items).map((item, i) => (
          <div key={i} role="listitem" className="min-w-0">
            <ItemTile item={item} />
          </div>
        ))}
      </div>
      <div>
        <h3 className="mb-1 text-xs font-medium text-muted-foreground">Most valuable</h3>
        <ul className="flex flex-col divide-y text-sm">
          {stacks.slice(0, TOP_STACKS).map((s) => (
            <li key={s.id} className="flex items-baseline justify-between gap-3 py-1.5">
              <span className="min-w-0 truncate">
                {s.quantity > 1 && (
                  <span className="text-muted-foreground tabular-nums">
                    {formatNumber(s.quantity)} ×{' '}
                  </span>
                )}
                {s.name}
              </span>
              <span className="shrink-0 tabular-nums">{s.value > 0 ? `${formatGp(s.value)} gp` : '—'}</span>
            </li>
          ))}
        </ul>
        {stacks.length > TOP_STACKS && (
          <p className="mt-1 text-xs text-muted-foreground">
            and {stacks.length - TOP_STACKS} more kinds of items
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * Current gear by slot in the worn-equipment layout, and the change log (the `equipment` category,
 * handoff §12 "equipment timeline"): each change lists the slots that changed against the previous
 * recorded set. Empty slots show the game's slot silhouette (D-95). Server component.
 */
import { formatGp, itemsValue, type ItemData } from '@hub/core';
import type { EquipmentChange } from '@hub/server';
import { ArrowRightIcon } from 'lucide-react';
import { DATE_TIME_OPTIONS, formatInZone } from './dates';
import { ItemTile } from './item-tile';
import {
  EQUIPMENT_GRID,
  equipmentBySlot,
  equipmentDiff,
  extraSlots,
  itemName,
  slotLabel,
} from './items';

/** Changes listed in the log. */
export const EQUIPMENT_LOG_SIZE = 10;

export function EquipmentGrid({ items }: { items: readonly ItemData[] }) {
  const bySlot = equipmentBySlot(items);
  const extra = extraSlots(bySlot);
  return (
    <div className="flex flex-col gap-3">
      <div
        className="mx-auto grid w-full max-w-60 grid-cols-3 gap-1.5"
        aria-label="Worn equipment"
        role="list"
      >
        {EQUIPMENT_GRID.flat().map((slot, i) =>
          slot === null ? (
            <div key={`gap-${i}`} aria-hidden />
          ) : (
            <div key={slot} role="listitem" className="min-w-0">
              <span className="sr-only">{slotLabel(slot)}: </span>
              <ItemTile item={bySlot.get(slot) ?? null} placeholder={slotLabel(slot)} slot={slot} />
            </div>
          ),
        )}
      </div>
      {extra.length > 0 && (
        <ul className="text-xs text-muted-foreground">
          {extra.map((slot) => {
            const item = bySlot.get(slot);
            return item ? (
              <li key={slot}>
                {slotLabel(slot)}: {itemName(item)}
              </li>
            ) : null;
          })}
        </ul>
      )}
      <p className="text-center text-xs text-muted-foreground">
        Gear value{' '}
        <span className="font-medium text-foreground">
          {formatGp(itemsValue([...items]) ?? 0)} gp
        </span>
      </p>
    </div>
  );
}

/**
 * The change log, newest first. `changes` is the history as returned (newest first); each entry is
 * compared with the next older one, and the oldest one returned with nothing (so it lists the set
 * that was worn; older changes may exist outside the range loaded, so it isn't called the first).
 */
export function EquipmentLog({
  changes,
  timezone,
}: {
  changes: readonly EquipmentChange[];
  timezone: string;
}) {
  if (changes.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">No gear changes recorded in the last 90 days.</p>
    );
  }
  return (
    <ol className="flex flex-col divide-y text-sm" aria-label="Gear changes">
      {changes.slice(0, EQUIPMENT_LOG_SIZE).map((change, i) => {
        const previous = changes[i + 1];
        const diff = equipmentDiff(previous ? previous.items : null, change.items);
        return (
          <li key={`${change.changedAt}-${i}`} className="flex flex-col gap-1 py-2">
            <time dateTime={change.changedAt} className="text-xs text-muted-foreground">
              {formatInZone(change.changedAt, timezone, DATE_TIME_OPTIONS)}
              {!previous && ' · the set worn then'}
            </time>
            {diff.length === 0 ? (
              <span className="text-muted-foreground">Same gear</span>
            ) : (
              <ul className="flex flex-col gap-0.5">
                {diff.map((d) => (
                  <li key={d.slot} className="flex flex-wrap items-center gap-x-1.5">
                    <span className="w-14 shrink-0 text-xs text-muted-foreground">
                      {slotLabel(d.slot)}
                    </span>
                    {d.before && previous ? (
                      <span className="text-muted-foreground line-through decoration-muted-foreground/60">
                        {itemName(d.before)}
                      </span>
                    ) : null}
                    {d.before && previous && d.after && (
                      <ArrowRightIcon role="img" aria-label="replaced by" className="size-3" />
                    )}
                    {d.after ? (
                      <span>{itemName(d.after)}</span>
                    ) : (
                      <span className="text-muted-foreground">(removed)</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ol>
  );
}

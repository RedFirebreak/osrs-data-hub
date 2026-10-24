/**
 * Current gear by slot in the worn-equipment layout, and the change log grouped into trips (the
 * `equipment` category, handoff §12 "equipment timeline", D-121). Empty slots show the game's slot
 * silhouette (D-95). Server component.
 */
import { formatGp, gearTrips, itemsValue, type GearTrip, type ItemData } from '@hub/core';
import type { EquipmentChange } from '@hub/server';
import { ItemIcon } from '@/components/icons/osrs-icon';
import { DATE_TIME_OPTIONS, formatInZone } from '@/lib/dates';
import { cn } from '@/lib/utils';
import { ItemTile } from './item-tile';
import { EQUIPMENT_GRID, equipmentBySlot, extraSlots, itemName, slotLabel } from './items';

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

/** Trips listed under the gear. */
export const GEAR_TRIPS_SHOWN = 8;

/** "13:56 – 14:43" on one day, else both with their dates; one time when the trip is one change. */
function tripTimes(trip: GearTrip, timezone: string): string {
  const start = formatInZone(trip.startedAt, timezone, DATE_TIME_OPTIONS) ?? '';
  if (trip.endedAt === trip.startedAt) return start;
  const sameDay =
    formatInZone(trip.startedAt, timezone, DAY_OPTIONS) ===
    formatInZone(trip.endedAt, timezone, DAY_OPTIONS);
  const end = formatInZone(trip.endedAt, timezone, sameDay ? TIME_OPTIONS : DATE_TIME_OPTIONS);
  return `${start} – ${end ?? ''}`;
}

const DAY_OPTIONS: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric' };
const TIME_OPTIONS: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' };

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Gear by trip (D-121): the change log grouped by `gearTrips` from @hub/core, newest first. A trip
 * shows the gear brought for it, a group of icons per slot: a slot with more than one icon is where
 * the player swapped, the longest worn first. `changes` is the history as returned (newest first).
 */
export function GearTrips({
  changes,
  timezone,
  now,
}: {
  changes: readonly EquipmentChange[];
  timezone: string;
  now: Date;
}) {
  const trips = gearTrips(changes, now).slice(0, GEAR_TRIPS_SHOWN);
  if (trips.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">No gear changes recorded in the last 90 days.</p>
    );
  }
  return (
    <ol className="flex flex-col divide-y text-sm" aria-label="Gear by trip">
      {trips.map((trip) => (
        <li key={trip.startedAt} className="flex flex-col gap-2 py-3">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-xs text-muted-foreground">
            <time dateTime={trip.startedAt}>{tripTimes(trip, timezone)}</time>
            <span>
              {trip.swaps === 0
                ? 'no swaps'
                : `${plural(trip.swaps, 'swap', 'swaps')} · ${plural(trip.setups, 'setup', 'setups')}`}
            </span>
          </div>
          <ul className="flex flex-wrap gap-1.5" aria-label="Gear brought">
            {trip.kit.map(({ slot, items }) => (
              <li
                key={slot}
                className={cn(
                  'flex items-center rounded-md border p-0.5',
                  items.length > 1 ? 'border-primary/40 bg-primary/5' : 'bg-muted/40',
                )}
              >
                <span className="sr-only">
                  {slotLabel(slot)}: {items.map(itemName).join(', ')}
                </span>
                {items.map((item) => (
                  <span key={item.id} title={`${slotLabel(slot)}: ${itemName(item)}`}>
                    <ItemIcon
                      itemId={item.id}
                      className="h-7 w-8"
                      fallback={
                        <span aria-hidden className="px-1 text-[10px] leading-tight">
                          {itemName(item)}
                        </span>
                      }
                    />
                  </span>
                ))}
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ol>
  );
}

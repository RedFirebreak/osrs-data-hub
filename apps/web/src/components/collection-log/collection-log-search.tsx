'use client';
/**
 * A character's shelf with a search bar above it (D-118): typing narrows the shelf to the slots
 * whose item or source contains the text (case-insensitive). A source that matches keeps all its
 * slots ("zul" shows the whole Zulrah row); otherwise only the matching items stay. Everything is
 * already on the page, so it filters as you type, without a round trip.
 */
import type { CollectionLogGroup } from '@hub/server';
import { SearchIcon } from 'lucide-react';
import { useDeferredValue, useId, useMemo, useState } from 'react';
import { Input } from '@/components/ui/input';
import { CollectionLogShelf, NO_SOURCE } from './collection-log';

/** The groups narrowed to `query` (see the file comment); all of them for a blank query. */
export function filterGroups(
  groups: readonly CollectionLogGroup[],
  query: string,
): CollectionLogGroup[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [...groups];
  const out: CollectionLogGroup[] = [];
  for (const g of groups) {
    if ((g.source ?? NO_SOURCE).toLowerCase().includes(q)) {
      out.push(g);
      continue;
    }
    const slots = g.slots.filter((s) => s.item.toLowerCase().includes(q));
    if (slots.length > 0) out.push({ source: g.source, slots });
  }
  return out;
}

export function CollectionLogSearch({
  groups,
  timezone,
}: {
  groups: readonly CollectionLogGroup[];
  timezone: string;
}) {
  const id = useId();
  const [query, setQuery] = useState('');
  const deferred = useDeferredValue(query);
  const shown = useMemo(() => filterGroups(groups, deferred), [groups, deferred]);
  const count = shown.reduce((n, g) => n + g.slots.length, 0);
  return (
    <div className="flex flex-col gap-4">
      <div role="search" className="relative">
        <label htmlFor={id} className="sr-only">
          Search by item or boss
        </label>
        <SearchIcon
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          id={id}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by item or boss"
          autoComplete="off"
          className="pl-9"
        />
      </div>
      {deferred.trim() !== '' && (
        <p aria-live="polite" className="text-xs text-muted-foreground">
          {count === 0
            ? 'Nothing in the log matches that.'
            : `${count} ${count === 1 ? 'slot' : 'slots'} match.`}
        </p>
      )}
      {shown.length > 0 && <CollectionLogShelf groups={shown} timezone={timezone} />}
    </div>
  );
}

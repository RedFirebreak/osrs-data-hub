'use client';
/**
 * "Add person" for a category shared with selected people: a popover with a name filter over the
 * guild's active members (GET /api/app/members, loaded the first time the picker opens and kept for
 * the page), leaving out whoever already has the grant and the account's own players.
 */
import type { ActiveMember, SharingSettings } from '@hub/server';
import type { Category } from '@hub/core';
import { LoaderCircleIcon, RotateCwIcon, SearchIcon, UserPlusIcon } from 'lucide-react';
import { useId, useState } from 'react';
import { UserAvatar } from '@/components/common/user-avatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { grantCandidates } from './sharing-model';

/** Rows the list renders; a longer match list asks for a narrower filter. */
const MAX_ROWS = 50;

export interface GrantPickerProps {
  category: Category;
  categoryLabel: string;
  settings: Pick<SharingSettings, 'categories' | 'contributors'>;
  /** The guild's members once loaded (shared by every picker on the page). */
  members: readonly ActiveMember[] | null;
  /** Loads `members`; resolves false when that failed (the panel has shown a toast). */
  loadMembers: () => Promise<boolean>;
  onGrant: (member: ActiveMember) => void;
  disabled?: boolean;
  /** The "Add person" button's id (the panel gives it the focus back after a change). */
  triggerId?: string;
}

export function GrantPicker({
  category,
  categoryLabel,
  settings,
  members,
  loadMembers,
  onGrant,
  disabled,
  triggerId,
}: GrantPickerProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  function load(): void {
    setLoading(true);
    setFailed(false);
    void loadMembers()
      .then((ok) => setFailed(!ok))
      .finally(() => setLoading(false));
  }

  function onOpenChange(next: boolean): void {
    setOpen(next);
    if (next && members === null && !loading) load();
    if (!next) setQuery('');
  }

  const candidates = members ? grantCandidates(members, settings, category, query) : [];
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button id={triggerId} variant="outline" size="sm" disabled={disabled}>
          <UserPlusIcon aria-hidden data-icon="inline-start" />
          Add person
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 max-w-[calc(100vw-2rem)]">
        <label htmlFor={`${id}-q`} className="text-xs font-medium text-muted-foreground">
          Who else may see {categoryLabel.toLowerCase()}?
        </label>
        <div className="relative">
          <SearchIcon
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            id={`${id}-q`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter members"
            className="pl-8"
            autoComplete="off"
            aria-controls={`${id}-list`}
          />
        </div>
        {members === null && failed && !loading ? (
          <div className="flex flex-col items-start gap-2 py-2 text-sm text-muted-foreground">
            <p role="alert">The member list couldn&apos;t be loaded.</p>
            <Button variant="outline" size="sm" onClick={load}>
              <RotateCwIcon aria-hidden data-icon="inline-start" />
              Try again
            </Button>
          </div>
        ) : members === null ? (
          <p className="flex items-center gap-2 py-2 text-sm text-muted-foreground" role="status">
            <LoaderCircleIcon aria-hidden className="size-4 animate-spin" />
            Loading members…
          </p>
        ) : candidates.length === 0 ? (
          <p className="py-2 text-sm text-muted-foreground">
            {query ? 'No member matches that name.' : 'Everyone already has access.'}
          </p>
        ) : (
          <ul id={`${id}-list`} className="-mx-1 max-h-64 overflow-y-auto">
            {candidates.slice(0, MAX_ROWS).map((m) => (
              <li key={m.userId}>
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    setQuery('');
                    onGrant(m);
                  }}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
                >
                  <UserAvatar name={m.name} image={m.image} size="sm" />
                  <span className="truncate">{m.name}</span>
                </button>
              </li>
            ))}
            {candidates.length > MAX_ROWS && (
              <li className="px-2 py-1 text-xs text-muted-foreground">
                {candidates.length - MAX_ROWS} more: type part of a name to narrow the list.
              </li>
            )}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}

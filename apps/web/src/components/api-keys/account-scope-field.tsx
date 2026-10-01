'use client';
/**
 * "Which accounts" of a user key (D-69): every account the user can see, now and later, or the ones
 * they pick from the list the page gives (what they can see right now; the server checks the same
 * rule). From FILTER_FROM accounts on, the list gets a filter; it starts empty each time the dialog
 * opens.
 */
import { useMemo, useState } from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import { FieldError } from '@/components/ui/field-error';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import type { CreateKeyForm } from './api-key-model';

export interface PickableAccount {
  publicId: string;
  name: string;
}

/** Show a filter above the account list from this many accounts on. */
const FILTER_FROM = 8;

export function AccountScopeField({
  id,
  accounts,
  scope,
  selected,
  onChange,
  error,
}: {
  /** Prefix of the field's ids (the radio group, the account boxes, the error). */
  id: string;
  /** Accounts the user can see right now, sorted by name. */
  accounts: PickableAccount[];
  scope: CreateKeyForm['scope'];
  /** Public ids of the picked accounts. */
  selected: readonly string[];
  onChange: (patch: Partial<Pick<CreateKeyForm, 'scope' | 'accountPublicIds'>>) => void;
  error: string | undefined;
}) {
  const [filter, setFilter] = useState('');
  const shownAccounts = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q === '' ? accounts : accounts.filter((a) => a.name.toLowerCase().includes(q));
  }, [accounts, filter]);

  function toggle(publicId: string, on: boolean): void {
    onChange({
      accountPublicIds: on
        ? [...new Set([...selected, publicId])]
        : selected.filter((p) => p !== publicId),
    });
  }

  return (
    <fieldset
      className="flex flex-col gap-2"
      aria-describedby={error ? `${id}-acc-error` : undefined}
    >
      <legend className="mb-1 text-sm font-medium">Which accounts</legend>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="radio"
          name={`${id}-scope`}
          value="all_visible"
          checked={scope === 'all_visible'}
          onChange={() => onChange({ scope: 'all_visible' })}
          className="mt-0.5 size-4 accent-primary"
        />
        <span>
          Every account I can see, now and later
          <span className="block text-xs text-muted-foreground">
            New accounts and newly shared ones are included automatically.
          </span>
        </span>
      </label>
      <label
        className={cn('flex items-start gap-2 text-sm', accounts.length === 0 && 'opacity-60')}
      >
        <input
          type="radio"
          name={`${id}-scope`}
          value="list"
          checked={scope === 'list'}
          disabled={accounts.length === 0}
          onChange={() => onChange({ scope: 'list' })}
          className="mt-0.5 size-4 accent-primary"
        />
        <span>
          Only the accounts I pick
          {accounts.length === 0 && (
            <span className="block text-xs text-muted-foreground">
              You can&apos;t see any accounts yet.
            </span>
          )}
        </span>
      </label>
      {scope === 'list' && accounts.length > 0 && (
        <div className="flex flex-col gap-2 pl-6">
          {accounts.length >= FILTER_FROM && (
            <Input
              type="search"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter accounts"
              aria-label="Filter accounts"
              className="h-8"
            />
          )}
          <div
            role="group"
            aria-label="Accounts"
            className="flex max-h-48 flex-col gap-2 overflow-y-auto rounded-lg border p-2"
          >
            {shownAccounts.length === 0 ? (
              <p className="text-sm text-muted-foreground">No account matches.</p>
            ) : (
              shownAccounts.map((account) => {
                const boxId = `${id}-acc-${account.publicId}`;
                return (
                  <div key={account.publicId} className="flex items-center gap-2">
                    <Checkbox
                      id={boxId}
                      checked={selected.includes(account.publicId)}
                      onCheckedChange={(checked) => toggle(account.publicId, checked === true)}
                      aria-invalid={error ? true : undefined}
                    />
                    <Label htmlFor={boxId} className="font-normal">
                      {account.name}
                    </Label>
                  </div>
                );
              })
            )}
          </div>
          <p className="text-xs text-muted-foreground">{selected.length} selected</p>
        </div>
      )}
      <FieldError id={`${id}-acc-error`} message={error} />
    </fieldset>
  );
}

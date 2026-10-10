'use client';
/**
 * The character a page is about, as a button that lists the viewer's other characters: on the
 * character page it switches between them, on Progress it picks whose progress is shown. The page
 * says where each choice leads (`href`, built on the server); with a single character there is
 * nothing to pick and the page doesn't render this.
 *
 *   <CharacterPicker current={account} options={own.map((a) => ({ ...a, href: accountHref(a.publicId) }))} />
 */
import { accountTypeLabel } from '@hub/core';
import { CheckIcon, ChevronDownIcon } from 'lucide-react';
import type { Route } from 'next';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export interface CharacterOption {
  publicId: string;
  name: string;
  accountType: number | null;
  href: Route;
}

export interface CharacterPickerProps {
  /** The public id of the character shown now. */
  current: string;
  options: readonly CharacterOption[];
}

export function CharacterPicker({ current, options }: CharacterPickerProps) {
  const shown = options.find((o) => o.publicId === current);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" className="pressable max-w-full gap-2 rounded-full">
          <span className="truncate">{shown?.name ?? 'Your characters'}</span>
          <ChevronDownIcon aria-hidden className="text-muted-foreground" />
          <span className="sr-only">Choose another character</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel>Your characters</DropdownMenuLabel>
        {options.map((option) => (
          <DropdownMenuItem key={option.publicId} asChild>
            <Link
              href={option.href}
              aria-current={option.publicId === current ? 'true' : undefined}
            >
              <span className="min-w-0 flex-1 truncate">{option.name}</span>
              {option.accountType !== null && option.accountType !== 0 && (
                <span className="text-xs text-muted-foreground">
                  {accountTypeLabel(option.accountType)}
                </span>
              )}
              {option.publicId === current && <CheckIcon aria-hidden />}
            </Link>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

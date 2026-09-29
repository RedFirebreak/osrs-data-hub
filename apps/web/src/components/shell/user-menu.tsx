'use client';
/** The signed-in user's avatar menu in the header: Settings, Privacy, Sign out. */
import { ChevronDownIcon, LogOutIcon, SettingsIcon, ShieldCheckIcon } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { signOut } from '@/lib/auth-client';

/** "Zezima" → "Z", "Lynx Titan" → "LT" (avatar fallback). */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.slice(0, 2).map((p) => Array.from(p)[0] ?? '');
  return letters.join('').toUpperCase() || '?';
}

export interface UserMenuProps {
  name: string;
  image: string | null;
  isAdmin: boolean;
}

export function UserMenu({ name, image, isAdmin }: UserMenuProps) {
  const [signingOut, setSigningOut] = useState(false);

  async function handleSignOut(): Promise<void> {
    setSigningOut(true);
    try {
      await signOut('/login');
    } catch {
      setSigningOut(false);
      toast.error("Couldn't sign out. Check your connection and try again.");
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="h-9 gap-2 px-1.5">
          <Avatar size="sm">
            {image && <AvatarImage src={image} alt="" />}
            <AvatarFallback>{initials(name)}</AvatarFallback>
          </Avatar>
          <span className="hidden max-w-36 truncate sm:inline">{name}</span>
          <ChevronDownIcon aria-hidden className="text-muted-foreground" />
          <span className="sr-only">Open the account menu</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="truncate">
          Signed in as <span className="text-foreground">{name}</span>
          {isAdmin && <span className="block">Admin</span>}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/settings">
            <SettingsIcon aria-hidden />
            Settings
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href="/privacy">
            <ShieldCheckIcon aria-hidden />
            Privacy
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={signingOut}
          onSelect={(event) => {
            event.preventDefault();
            void handleSignOut();
          }}
        >
          <LogOutIcon aria-hidden />
          {signingOut ? 'Signing out…' : 'Sign out'}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

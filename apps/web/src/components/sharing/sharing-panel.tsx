'use client';
/**
 * The sharing panel of an account page (handoff §10, §12), for its owner, its players (read-only)
 * and admins (who may override):
 * - per category an audience (Private / Guild / Selected people), the default marked, and for
 *   "Selected people" the members granted it with an "Add person" picker;
 * - the account's players (owner and contributors) with block / unblock / remove, and handing
 *   ownership to one of them (confirmed in a dialog);
 * - "Claim ownership" for a player of an account that has no owner.
 * Every change is one PATCH /api/app/accounts/[publicId]/sharing (D-36); the panel shows the
 * settings the server returns. A change of owner refreshes the page (the viewer's rights change).
 */
import type { Audience, Category } from '@hub/core';
import type { ActiveMember, SharingContributor, SharingSettings } from '@hub/server';
import {
  BanIcon,
  CrownIcon,
  EllipsisVerticalIcon,
  LockIcon,
  UserCheckIcon,
  UserMinusIcon,
  XIcon,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import type { SharingChange } from '@/app/api/app/accounts/sharing-change';
import { UserAvatar } from '@/components/account/user-avatar';
import { RelativeTime } from '@/components/events/relative-time';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { GrantPicker } from './grant-picker';
import {
  AUDIENCE_OPTIONS,
  audienceLabel,
  errorMessage,
  successMessage,
  transferCandidates,
} from './sharing-model';

export interface SharingPanelProps {
  publicId: string;
  initial: SharingSettings;
  /** CATEGORY_LABELS from @hub/core (passed as data, NEXT-12). */
  categoryLabels: Readonly<Record<Category, { label: string; covers: string }>>;
  /** DEFAULT_AUDIENCE from @hub/core. */
  defaults: Readonly<Record<Category, Audience>>;
  /** The account has an owner (claiming is offered only when it hasn't). */
  hasOwner: boolean;
  /** The viewer's relation to the account. */
  relation: 'owner' | 'contributor' | 'member' | 'none';
  /** Server render time (ISO). */
  now: string;
}

type Confirm =
  | { kind: 'transfer'; user: SharingContributor }
  | { kind: 'remove'; user: SharingContributor }
  | { kind: 'block'; user: SharingContributor }
  | { kind: 'claim' };

interface PatchResponse {
  sharing?: SharingSettings | null;
  error?: { message?: string };
}

export function SharingPanel({
  publicId,
  initial,
  categoryLabels,
  defaults,
  hasOwner,
  relation,
  now,
}: SharingPanelProps) {
  const router = useRouter();
  const id = useId();
  const [settings, setSettings] = useState(initial);
  const [pending, setPending] = useState(false);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [members, setMembers] = useState<ActiveMember[] | null>(null);
  const canManage = settings.canManage;

  async function loadMembers(): Promise<void> {
    try {
      const res = await fetch('/api/app/members', { credentials: 'same-origin' });
      const body = (await res.json().catch(() => null)) as { members?: ActiveMember[] } | null;
      if (res.ok && body?.members) setMembers(body.members);
      else toast.error("The member list couldn't be loaded. Try again in a moment.");
    } catch {
      toast.error("The member list couldn't be loaded. Check your connection.");
    }
  }

  async function apply(change: SharingChange, names: { category?: string; user?: string } = {}) {
    setPending(true);
    try {
      const res = await fetch(`/api/app/accounts/${encodeURIComponent(publicId)}/sharing`, {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(change),
      });
      const body = (await res.json().catch(() => null)) as PatchResponse | null;
      if (!res.ok) {
        toast.error(errorMessage(body?.error?.message, "That change couldn't be saved."));
        return;
      }
      if (body?.sharing) setSettings(body.sharing);
      toast.success(successMessage(change, names));
      // A new owner changes what the viewer may do on the whole page.
      if (change.action === 'transfer' || change.action === 'claim' || !body?.sharing) {
        router.refresh();
      }
    } catch {
      toast.error("That change couldn't be saved. Check your connection and try again.");
    } finally {
      setPending(false);
    }
  }

  function runConfirmed(c: Confirm): void {
    setConfirm(null);
    if (c.kind === 'claim') void apply({ action: 'claim' });
    else if (c.kind === 'transfer') {
      void apply({ action: 'transfer', userId: c.user.userId }, { user: c.user.name });
    } else if (c.kind === 'remove') {
      void apply({ action: 'remove', userId: c.user.userId }, { user: c.user.name });
    } else void apply({ action: 'block', userId: c.user.userId }, { user: c.user.name });
  }

  const canClaim = !hasOwner && relation === 'contributor';
  return (
    <div className="flex flex-col gap-6">
      {!canManage && (
        <p className="flex items-start gap-2 text-sm text-muted-foreground">
          <LockIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
          {hasOwner
            ? 'Only the owner can change who sees what. As a player of this account you always see everything.'
            : 'This account has no owner, so nobody can change its sharing until a player claims it.'}
        </p>
      )}
      {canClaim && (
        <Alert role="status">
          <CrownIcon aria-hidden />
          <AlertTitle>Claim this account</AlertTitle>
          <AlertDescription className="flex flex-col items-start gap-2">
            <span>
              Its owner is gone. As one of its players you can become the owner and decide who
              sees what.
            </span>
            <Button size="sm" disabled={pending} onClick={() => setConfirm({ kind: 'claim' })}>
              Claim ownership
            </Button>
          </AlertDescription>
        </Alert>
      )}

      <section aria-labelledby={`${id}-categories`} className="flex flex-col gap-2">
        <h3 id={`${id}-categories`} className="text-sm font-semibold">
          Who can see what
        </h3>
        <p className="text-xs text-muted-foreground">
          The account&apos;s players always see everything. The plugin decides what reaches the hub
          at all.
        </p>
        <ul className="flex flex-col divide-y">
          {settings.categories.map((c) => {
            const { label, covers } = categoryLabels[c.category];
            const selectId = `${id}-${c.category}`;
            return (
              <li key={c.category} className="flex flex-col gap-2 py-3">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <label htmlFor={selectId} className="text-sm font-medium">
                      {label}
                    </label>
                    <p className="text-xs text-muted-foreground">{covers}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {c.isDefault && (
                      <Badge variant="secondary" title="No choice made yet: the hub's default">
                        Default
                      </Badge>
                    )}
                    <Select
                      value={c.audience}
                      disabled={!canManage || pending}
                      onValueChange={(value) =>
                        void apply(
                          {
                            action: 'audience',
                            category: c.category,
                            audience: value as Audience,
                          },
                          { category: label },
                        )
                      }
                    >
                      <SelectTrigger id={selectId} size="sm" className="w-44">
                        <SelectValue>{audienceLabel(c.audience)}</SelectValue>
                      </SelectTrigger>
                      <SelectContent position="popper" align="end">
                        {AUDIENCE_OPTIONS.map((o) => (
                          <SelectItem key={o.value} value={o.value}>
                            <span className="flex flex-col">
                              <span>
                                {o.label}
                                {defaults[c.category] === o.value && (
                                  <span className="text-muted-foreground"> (default)</span>
                                )}
                              </span>
                              <span className="text-xs text-muted-foreground">{o.hint}</span>
                            </span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                {c.audience === 'selected' && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    {c.grants.length === 0 && (
                      <span className="text-xs text-muted-foreground">
                        Nobody added yet: only the players see it.
                      </span>
                    )}
                    {c.grants.map((g) => (
                      <Badge key={g.userId} variant="outline" className="h-6 gap-1 pr-1">
                        {g.name}
                        {canManage && (
                          <button
                            type="button"
                            disabled={pending}
                            onClick={() =>
                              void apply(
                                { action: 'revoke', category: c.category, userId: g.userId },
                                { category: label, user: g.name },
                              )
                            }
                            className="rounded-full p-0.5 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
                            aria-label={`Remove ${g.name} from ${label}`}
                          >
                            <XIcon aria-hidden className="size-3" />
                          </button>
                        )}
                      </Badge>
                    ))}
                    {canManage && (
                      <GrantPicker
                        category={c.category}
                        categoryLabel={label}
                        settings={settings}
                        members={members}
                        loadMembers={loadMembers}
                        disabled={pending}
                        onGrant={(m) =>
                          void apply(
                            { action: 'grant', category: c.category, userId: m.userId },
                            { category: label, user: m.name },
                          )
                        }
                      />
                    )}
                  </div>
                )}
                {c.audience !== 'selected' && c.grants.length > 0 && (
                  <p className="text-xs text-muted-foreground">
                    {c.grants.length === 1 ? '1 person is' : `${c.grants.length} people are`}{' '}
                    added; that applies while this is set to Selected people.
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      <section aria-labelledby={`${id}-players`} className="flex flex-col gap-2">
        <h3 id={`${id}-players`} className="text-sm font-semibold">
          Players
        </h3>
        <p className="text-xs text-muted-foreground">
          Members whose RuneLite reported this account. A blocked player&apos;s data is dropped and
          they lose the player&apos;s view.
        </p>
        {settings.contributors.length === 0 ? (
          <p className="text-sm text-muted-foreground">No players on record.</p>
        ) : (
          <ul className="flex flex-col divide-y">
            {settings.contributors.map((c) => (
              <li key={c.userId} className="flex items-center gap-3 py-2">
                <UserAvatar name={c.name} image={c.image} />
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
                    <span className="truncate">{c.name}</span>
                    {c.role === 'owner' && (
                      <Badge variant="outline">
                        <CrownIcon aria-hidden data-icon="inline-start" />
                        Owner
                      </Badge>
                    )}
                    {c.blocked && <Badge variant="destructive">Blocked</Badge>}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    <RelativeTime date={c.lastSeen} now={now} prefix="Last reported" />
                  </p>
                </div>
                {canManage && c.role !== 'owner' && (
                  <PlayerMenu
                    player={c}
                    disabled={pending}
                    onTransfer={() => setConfirm({ kind: 'transfer', user: c })}
                    onBlock={() => setConfirm({ kind: 'block', user: c })}
                    onUnblock={() =>
                      void apply({ action: 'unblock', userId: c.userId }, { user: c.name })
                    }
                    onRemove={() => setConfirm({ kind: 'remove', user: c })}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
        {canManage && transferCandidates(settings.contributors).length === 0 && (
          <p className="text-xs text-muted-foreground">
            Ownership can be handed to another player of this account once their RuneLite has
            reported it.
          </p>
        )}
      </section>

      <AlertDialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
        <AlertDialogContent>
          {confirm && <ConfirmText confirm={confirm} />}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant={confirm?.kind === 'claim' || confirm?.kind === 'transfer' ? 'default' : 'destructive'}
              onClick={() => confirm && runConfirmed(confirm)}
            >
              {confirm ? confirmLabel(confirm) : 'Confirm'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function PlayerMenu({
  player,
  disabled,
  onTransfer,
  onBlock,
  onUnblock,
  onRemove,
}: {
  player: SharingContributor;
  disabled: boolean;
  onTransfer: () => void;
  onBlock: () => void;
  onUnblock: () => void;
  onRemove: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" disabled={disabled} aria-label={`Manage ${player.name}`}>
          <EllipsisVerticalIcon aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuItem disabled={player.blocked} onSelect={onTransfer}>
          <CrownIcon aria-hidden />
          Make owner
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {player.blocked ? (
          <DropdownMenuItem onSelect={onUnblock}>
            <UserCheckIcon aria-hidden />
            Unblock
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem variant="destructive" onSelect={onBlock}>
            <BanIcon aria-hidden />
            Block
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          variant="destructive"
          disabled={player.blocked}
          onSelect={onRemove}
          title={player.blocked ? 'Unblock first: removing would lift the block' : undefined}
        >
          <UserMinusIcon aria-hidden />
          Remove
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function confirmLabel(confirm: Confirm): string {
  switch (confirm.kind) {
    case 'claim':
      return 'Claim ownership';
    case 'transfer':
      return 'Make owner';
    case 'block':
      return 'Block';
    case 'remove':
      return 'Remove';
  }
}

function ConfirmText({ confirm }: { confirm: Confirm }) {
  let title: string;
  let text: string;
  switch (confirm.kind) {
    case 'claim':
      title = 'Claim this account?';
      text =
        'You become its owner: you decide who sees each category, and you can block players or hand the account on.';
      break;
    case 'transfer':
      title = `Make ${confirm.user.name} the owner?`;
      text = `${confirm.user.name} will control this account's sharing and players. You stay a player and keep seeing everything, but you can't change sharing any more unless they hand it back.`;
      break;
    case 'block':
      title = `Block ${confirm.user.name}?`;
      text = `Nothing their RuneLite sends for this account is stored any more, and they lose the player's view. You can unblock them later.`;
      break;
    case 'remove':
      title = `Remove ${confirm.user.name}?`;
      text =
        'They stop being a player of this account. If their RuneLite reports it again, they are added back; block them to keep them out.';
      break;
  }
  return (
    <AlertDialogHeader>
      <AlertDialogTitle>{title}</AlertDialogTitle>
      <AlertDialogDescription className="text-left">{text}</AlertDialogDescription>
    </AlertDialogHeader>
  );
}

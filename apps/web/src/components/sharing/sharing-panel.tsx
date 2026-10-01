'use client';
/**
 * The sharing panel of an account page (handoff §10, §12), for its owner, its players (read-only)
 * and admins (who may override):
 * - per category an audience (Private / Guild / Selected people), the default marked, and for
 *   "Selected people" the members granted it with an "Add person" picker (CategoryAudiences);
 * - the account's players (owner and contributors) with block / unblock / remove, and handing
 *   ownership to one of them (confirmed in a dialog);
 * - "Claim ownership" for a player of an account that has no owner.
 * Every change is one PATCH /api/app/accounts/[publicId]/sharing (D-36, useSharing); the panel shows
 * the settings the server returns. A change of owner refreshes the page (the viewer's rights change).
 *
 * Focus (lib/focus.ts): the controls are disabled while a change runs, and some go away with it, so
 * the browser drops the focus to <body>. A control that stays (an audience select, "Add person", a
 * player's menu after unblocking) gets it back once the change settled (useSharing); after a
 * confirmed dialog it goes to the heading of the section concerned (Players; for a new owner the
 * Sharing card's, as the panel remounts), and after Cancel back to the control that opened the
 * dialog, which Radix can't do here: the dialog has no Trigger.
 */
import type { SharingContributor, SharingSettings } from '@hub/server';
import {
  BanIcon,
  CrownIcon,
  EllipsisVerticalIcon,
  LockIcon,
  UserCheckIcon,
  UserMinusIcon,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useId, useRef, useState } from 'react';
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
import { headingOfSection, useFocusReturn } from '@/lib/focus';
import { CategoryAudiences } from './category-audiences';
import { transferCandidates } from './sharing-model';
import { useSharing } from './use-sharing';

export interface SharingPanelProps {
  publicId: string;
  initial: SharingSettings;
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

export function SharingPanel({ publicId, initial, hasOwner, relation, now }: SharingPanelProps) {
  const router = useRouter();
  const id = useId();
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const playersHeadingRef = useRef<HTMLHeadingElement>(null);
  const claimRef = useRef<HTMLButtonElement>(null);
  const dialogFocus = useFocusReturn();

  /** The Sharing card's heading, outside the panel: it stays when a new owner remounts the panel. */
  const cardHeading = () => headingOfSection(rootRef.current);

  const sharing = useSharing(publicId, initial, {
    focusFallback: cardHeading,
    // A new owner changes what the viewer may do on the whole page.
    onRightsChanged: () => router.refresh(),
  });
  const { settings, pending, apply } = sharing;
  const canManage = settings.canManage;

  /** The trigger of a player's menu (it stays when they are blocked or unblocked). */
  const manageId = (userId: string) => `${id}-manage-${userId}`;

  /** Opens a confirmation; Cancel returns the focus to `opener` (the dialog has no Trigger). */
  function openConfirm(c: Confirm, opener: () => HTMLElement | null): void {
    dialogFocus.set(opener, cardHeading);
    setConfirm(c);
  }

  function runConfirmed(c: Confirm): void {
    // A new owner remounts the panel (its key changes), taking the Players heading with it.
    dialogFocus.set(
      c.kind === 'claim' || c.kind === 'transfer' ? null : playersHeadingRef.current,
      cardHeading,
    );
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
    <div ref={rootRef} className="flex flex-col gap-6">
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
              Its owner is gone. As one of its players you can become the owner and decide who sees
              what.
            </span>
            <Button
              ref={claimRef}
              size="sm"
              disabled={pending}
              onClick={() => openConfirm({ kind: 'claim' }, () => claimRef.current)}
            >
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
        <CategoryAudiences idPrefix={id} sharing={sharing} />
      </section>

      <section aria-labelledby={`${id}-players`} className="flex flex-col gap-2">
        <h3 ref={playersHeadingRef} id={`${id}-players`} className="text-sm font-semibold">
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
                    triggerId={manageId(c.userId)}
                    player={c}
                    disabled={pending}
                    onTransfer={() =>
                      openConfirm({ kind: 'transfer', user: c }, () =>
                        document.getElementById(manageId(c.userId)),
                      )
                    }
                    onBlock={() =>
                      openConfirm({ kind: 'block', user: c }, () =>
                        document.getElementById(manageId(c.userId)),
                      )
                    }
                    onUnblock={() =>
                      void apply(
                        { action: 'unblock', userId: c.userId },
                        { user: c.name },
                        manageId(c.userId),
                      )
                    }
                    onRemove={() =>
                      openConfirm({ kind: 'remove', user: c }, () =>
                        document.getElementById(manageId(c.userId)),
                      )
                    }
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
        <AlertDialogContent onCloseAutoFocus={dialogFocus.onCloseAutoFocus}>
          {confirm && (
            <ConfirmText
              confirm={confirm}
              viewerIsOwner={relation === 'owner'}
              hasOwner={hasOwner}
            />
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant={
                confirm?.kind === 'claim' || confirm?.kind === 'transfer'
                  ? 'default'
                  : 'destructive'
              }
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
  triggerId,
  player,
  disabled,
  onTransfer,
  onBlock,
  onUnblock,
  onRemove,
}: {
  triggerId: string;
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
        <Button
          id={triggerId}
          variant="ghost"
          size="icon-sm"
          disabled={disabled}
          aria-label={`Manage ${player.name}`}
        >
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

function ConfirmText({
  confirm,
  viewerIsOwner,
  hasOwner,
}: {
  confirm: Confirm;
  /** false for an admin overriding (they aren't the one handing the account on). */
  viewerIsOwner: boolean;
  hasOwner: boolean;
}) {
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
      text = viewerIsOwner
        ? `${confirm.user.name} will control this account's sharing and players. You stay a player and keep seeing everything, but you can't change sharing any more unless they hand it back.`
        : `${confirm.user.name} will control this account's sharing and players.${hasOwner ? ' The current owner stays a player of it.' : ''}`;
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

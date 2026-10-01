'use client';
/**
 * The state behind an account's sharing controls (the account page's panel and the wizard's last
 * step): the settings as the server last returned them, and one PATCH
 * /api/app/accounts/[publicId]/sharing per change (D-36), with a toast for its outcome.
 *
 * Focus (lib/focus.ts): the controls are disabled while a change runs, and some go away with it, so
 * the browser drops the focus to <body>. `apply` takes the id of a control that stays; once the
 * change settled it gets the focus back, or `focusFallback` when it went away.
 */
import type { ActiveMember, SharingSettings } from '@hub/server';
import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { SharingChange } from '@/app/api/app/accounts/sharing-change';
import { focusIsLost, moveFocus, type FocusTarget } from '@/lib/focus';
import { errorMessage, successMessage } from './sharing-model';

interface PatchResponse {
  sharing?: SharingSettings | null;
  error?: { message?: string };
}

export interface UseSharingOptions {
  /** Where the focus goes when the control a change came from is gone afterwards. */
  focusFallback?: FocusTarget;
  /** The change altered what the viewer may do (a new owner, or they may no longer read the settings). */
  onRightsChanged?: () => void;
}

export interface Sharing {
  settings: SharingSettings;
  /** A change is running: the controls are disabled. */
  pending: boolean;
  /** The guild's members for the grant picker, once loaded. */
  members: ActiveMember[] | null;
  /** Loads `members`; false (after a toast) when that failed. */
  loadMembers(): Promise<boolean>;
  /**
   * Sends one change. `refocus`: id of the control to give the focus back to afterwards, when the
   * focus was lost while the change ran.
   */
  apply(
    change: SharingChange,
    names?: { category?: string; user?: string },
    refocus?: string,
  ): Promise<void>;
}

export function useSharing(
  publicId: string,
  initial: SharingSettings,
  options: UseSharingOptions = {},
): Sharing {
  const [settings, setSettings] = useState(initial);
  const [pending, setPending] = useState(false);
  const [members, setMembers] = useState<ActiveMember[] | null>(null);
  /** Id of the control that gets the focus back once the running change settled (effect below). */
  const refocusId = useRef<string | null>(null);
  const { focusFallback, onRightsChanged } = options;

  // The change settled and the controls are enabled again: if the focus fell to <body> meanwhile,
  // back to the control the change came from (or the fallback when it went away).
  const refocus = useEffectEvent(() => {
    const target = refocusId.current;
    if (target === null) return;
    refocusId.current = null;
    if (focusIsLost()) moveFocus(document.getElementById(target), focusFallback);
  });
  useEffect(() => {
    if (!pending) refocus();
  }, [pending]);

  async function loadMembers(): Promise<boolean> {
    try {
      const res = await fetch('/api/app/members', { credentials: 'same-origin' });
      const body = (await res.json().catch(() => null)) as { members?: ActiveMember[] } | null;
      if (res.ok && body?.members) {
        setMembers(body.members);
        return true;
      }
      toast.error("The member list couldn't be loaded. Try again in a moment.");
    } catch {
      toast.error("The member list couldn't be loaded. Check your connection.");
    }
    return false;
  }

  async function apply(
    change: SharingChange,
    names: { category?: string; user?: string } = {},
    refocus?: string,
  ): Promise<void> {
    refocusId.current = refocus ?? null;
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
      if (change.action === 'transfer' || change.action === 'claim' || !body?.sharing) {
        onRightsChanged?.();
      }
    } catch {
      toast.error("That change couldn't be saved. Check your connection and try again.");
    } finally {
      setPending(false);
    }
  }

  return { settings, pending, members, loadMembers, apply };
}

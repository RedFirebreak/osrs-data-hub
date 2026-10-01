'use client';
/**
 * The Users table's actions for one user (handoff §12, §14): Offboard (reason 'admin', D-35) and
 * Restore, each behind a confirmation that says what happens. Which buttons appear is decided by
 * userActions() (admin-model.ts); the routes and @hub/server check again.
 */
import type { OffboardReason, UserStatus } from '@hub/db';
import { UserRoundCheckIcon, UserRoundXIcon } from 'lucide-react';
import { toast } from 'sonner';
import {
  adminFailure,
  adminUserActionPath,
  offboardReasonLabel,
  pluralDays,
  userActions,
} from './admin-model';
import { ConfirmAction } from './confirm-action';

export interface UserActionsProps {
  userId: string;
  name: string;
  status: UserStatus;
  offboardReason: OffboardReason | null;
  isSelf: boolean;
  /** OFFBOARD_GRACE_DAYS. */
  graceDays: number;
}

function count(body: unknown, key: string): number {
  const value = (body as Record<string, unknown> | null)?.[key];
  return typeof value === 'number' ? value : 0;
}

export function UserActions({
  userId,
  name,
  status,
  offboardReason,
  isSelf,
  graceDays,
}: UserActionsProps) {
  const actions = userActions({ status, offboardReason, isSelf });
  // Only your own active row has no action; its "You" badge next to the name says why.
  if (!actions.offboard && !actions.restore) return null;
  const inGrace = status === 'grace';

  return (
    <div className="flex flex-wrap justify-end gap-2">
      {actions.restore && (
        <ConfirmAction
          srSuffix={name}
          title={`Restore ${name}?`}
          description={
            <>
              {offboardReason === 'self_delete' && (
                <p>
                  <strong>{name} asked for their data to be deleted.</strong> Restoring them cancels
                  that request, and nothing is deleted.
                </p>
              )}
              <p>
                {name} becomes an active member again and their hidden accounts become visible.
                Their devices stay revoked: they pair again through the wizard.
              </p>
              <p>
                If Discord still says they left the server or lost the required role, the next
                membership check offboards them again.
              </p>
            </>
          }
          confirmLabel="Restore user"
          request={{ path: adminUserActionPath(userId, 'restore'), method: 'POST' }}
          failure={adminFailure("Couldn't restore the user. Try again in a moment.")}
          onDone={(body) => {
            const unhidden = count(body, 'unhidden');
            toast.success(`${name} restored`, {
              description:
                unhidden > 0
                  ? `${unhidden} hidden ${unhidden === 1 ? 'account is' : 'accounts are'} visible again.`
                  : undefined,
            });
          }}
        >
          <UserRoundCheckIcon aria-hidden data-icon="inline-start" />
          Restore
        </ConfirmAction>
      )}
      {actions.offboard && (
        <ConfirmAction
          variant="destructive"
          srSuffix={name}
          title={`Offboard ${name}?`}
          description={
            inGrace ? (
              <>
                <p>
                  {name} is already in their grace period ({offboardReasonLabel(offboardReason)}).
                  Offboarding them as an admin keeps the date it ends, but logging in again will no
                  longer restore them: only an admin can.
                </p>
              </>
            ) : (
              <>
                <p>
                  {name} is signed out everywhere, all their devices and API keys stop working, and
                  the accounts they own pass to their longest-linked active contributor or are
                  hidden.
                </p>
                <p>
                  After {pluralDays(graceDays)} their data is deleted. Until then you can restore
                  them here; logging in again does not.
                </p>
              </>
            )
          }
          confirmLabel="Offboard user"
          request={{ path: adminUserActionPath(userId, 'offboard'), method: 'POST' }}
          failure={adminFailure("Couldn't offboard the user. Try again in a moment.")}
          onDone={(body) => {
            const devices = count(body, 'revokedDevices');
            const transferred = count(body, 'transferred');
            toast.success(`${name} offboarded`, {
              description: inGrace
                ? 'Only an admin can restore them now.'
                : `${devices} ${devices === 1 ? 'device' : 'devices'} revoked · ` +
                  `${transferred} ${transferred === 1 ? 'account' : 'accounts'} transferred · ` +
                  `${count(body, 'hidden')} hidden.`,
            });
          }}
        >
          <UserRoundXIcon aria-hidden data-icon="inline-start" />
          Offboard
        </ConfirmAction>
      )}
    </div>
  );
}

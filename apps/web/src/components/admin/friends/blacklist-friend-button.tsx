'use client';
/**
 * Admin → Friends: "Blacklist" for one invite (D-117), behind a confirmation dialog: POST
 * /api/app/admin/friend-blacklist. The invite goes, nobody can invite the name again, and a friend
 * who signed in on it loses access.
 */
import { BanIcon } from 'lucide-react';
import { toast } from 'sonner';
import { ConfirmAction } from '@/components/common/confirm-action';
import { FRIEND_BLACKLIST_API_PATH, adminFailure, pluralDays } from '../admin-model';

export interface BlacklistFriendButtonProps {
  username: string;
  invitedBy: string;
  /** Whether a friend signed in on the invite and still has access. */
  signedIn: boolean;
  graceDays: number;
}

export function BlacklistFriendButton({
  username,
  invitedBy,
  signedIn,
  graceDays,
}: BlacklistFriendButtonProps) {
  return (
    <ConfirmAction
      variant="destructive"
      srSuffix={username}
      title={`Blacklist ${username}?`}
      description={
        <>
          <p>
            {invitedBy}&apos;s invite for {username} is removed, and nobody can invite {username}{' '}
            again until you take the name off the blacklist.
          </p>
          {signedIn && (
            <p>
              {username} is signed out and can&apos;t sign in any more, also under another Discord
              username. Their data is kept for {pluralDays(graceDays)}, then deleted.
            </p>
          )}
        </>
      }
      confirmLabel="Blacklist"
      request={{ path: FRIEND_BLACKLIST_API_PATH, method: 'POST', json: { username } }}
      failure={adminFailure(`Couldn't blacklist ${username}. Try again in a moment.`)}
      onDone={() => toast.success(`${username} blacklisted`)}
    >
      <BanIcon aria-hidden data-icon="inline-start" />
      Blacklist
    </ConfirmAction>
  );
}

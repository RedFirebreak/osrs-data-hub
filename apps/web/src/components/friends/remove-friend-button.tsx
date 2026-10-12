'use client';
/**
 * "Remove" for one friend (D-117), behind a confirmation dialog (ConfirmAction): DELETE
 * /api/app/friends/[id]. A friend who signed in loses access as a member leaving the guild would;
 * one who never signed in just leaves the list.
 */
import { UserMinusIcon } from 'lucide-react';
import { toast } from 'sonner';
import { ConfirmAction } from '@/components/common/confirm-action';
import { REMOVE_FRIEND_FAILURE, friendPath } from './friends-model';

export interface RemoveFriendButtonProps {
  inviteId: string;
  username: string;
  /** Whether they signed in on the invite (then removing them takes their access away). */
  signedIn: boolean;
  graceDays: number;
}

export function RemoveFriendButton({
  inviteId,
  username,
  signedIn,
  graceDays,
}: RemoveFriendButtonProps) {
  return (
    <ConfirmAction
      variant="outline"
      srSuffix={username}
      title={`Remove ${username}?`}
      description={
        signedIn
          ? `${username} is signed out and can't sign in any more, as if they had left the guild. Their data is kept for ${graceDays} days, then deleted, unless they are invited again before that.`
          : `${username} can't use this invite to sign in any more. This frees the place for someone else.`
      }
      confirmLabel="Remove friend"
      request={{ path: friendPath(inviteId), method: 'DELETE' }}
      failure={REMOVE_FRIEND_FAILURE}
      onDone={() => toast.success(`${username} removed`)}
    >
      <UserMinusIcon aria-hidden data-icon="inline-start" />
      Remove
    </ConfirmAction>
  );
}

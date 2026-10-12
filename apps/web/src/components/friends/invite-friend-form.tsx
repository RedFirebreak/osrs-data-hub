'use client';
/**
 * Invite a friend (D-117): the member types their friend's Discord username, POST /api/app/friends.
 * On success the friend is on the list below (a refresh) and a toast says they are part of the hub.
 * The field is checked as typed with the server's own rule (normalizeDiscordUsername).
 */
import { normalizeDiscordUsername } from '@hub/core';
import { LoaderCircleIcon, UserPlusIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { FieldError } from '@/components/common/field-error';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useApiRequest } from '@/lib/use-api-request';
import { FRIENDS_API_PATH, INVITE_FAILURE } from './friends-model';

export interface InviteFriendFormProps {
  /** Where the friend signs in, for the toast. */
  hubOrigin: string;
  disabled?: boolean;
}

export function InviteFriendForm({ hubOrigin, disabled = false }: InviteFriendFormProps) {
  const router = useRouter();
  const id = useId();
  const [text, setText] = useState('');
  const [touched, setTouched] = useState(false);
  const { pending, error, setError, send } = useApiRequest();

  const username = normalizeDiscordUsername(text);
  const fieldError =
    touched && text.trim() !== '' && username === null
      ? 'A Discord username has 2 to 32 lowercase letters, digits, dots or underscores.'
      : undefined;

  async function invite(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setTouched(true);
    if (username === null || disabled) return;
    const res = await send(
      FRIENDS_API_PATH,
      { method: 'POST', json: { username } },
      INVITE_FAILURE,
    );
    if (!res.ok) return;
    setText('');
    setTouched(false);
    toast.success(`${username} is now part of the hub!`, {
      description: `They can sign in with Discord at ${hubOrigin}.`,
    });
    router.refresh();
  }

  return (
    <form onSubmit={(e) => void invite(e)} noValidate className="flex flex-col gap-2">
      <Label htmlFor={`${id}-username`}>Their Discord username</Label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          id={`${id}-username`}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="username"
          maxLength={64}
          value={text}
          disabled={pending || disabled}
          onChange={(e) => {
            setError(null);
            setText(e.target.value);
          }}
          onBlur={() => setTouched(true)}
          aria-invalid={fieldError || error ? true : undefined}
          aria-describedby={`${id}-help${fieldError ? ` ${id}-error` : ''}${error ? ` ${id}-hub-error` : ''}`}
          className="sm:max-w-xs"
        />
        <Button type="submit" disabled={pending || disabled || text.trim() === ''}>
          {pending ? (
            <LoaderCircleIcon aria-hidden className="animate-spin" />
          ) : (
            <UserPlusIcon aria-hidden data-icon="inline-start" />
          )}
          Invite
        </Button>
      </div>
      <p id={`${id}-help`} className="text-sm text-muted-foreground">
        The name under their display name in Discord, not the display name itself.
      </p>
      <FieldError id={`${id}-error`} message={fieldError} />
      {error && (
        <p id={`${id}-hub-error`} role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </form>
  );
}

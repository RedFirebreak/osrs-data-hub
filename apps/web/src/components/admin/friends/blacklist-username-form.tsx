'use client';
/**
 * Admin → Friends: blacklist a Discord username nobody has invited yet (D-117), POST
 * /api/app/admin/friend-blacklist. Checked as typed with the server's rule.
 */
import { normalizeDiscordUsername } from '@hub/core';
import { BanIcon, LoaderCircleIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { FieldError } from '@/components/common/field-error';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useApiRequest } from '@/lib/use-api-request';
import { FRIEND_BLACKLIST_API_PATH, adminFailure } from '../admin-model';

export function BlacklistUsernameForm() {
  const router = useRouter();
  const id = useId();
  const [text, setText] = useState('');
  const { pending, error, setError, send } = useApiRequest();
  const username = normalizeDiscordUsername(text);
  const fieldError =
    text.trim() !== '' && username === null
      ? 'A Discord username has 2 to 32 lowercase letters, digits, dots or underscores.'
      : undefined;

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (username === null) return;
    const res = await send(
      FRIEND_BLACKLIST_API_PATH,
      { method: 'POST', json: { username } },
      { ...adminFailure(`Couldn't blacklist ${username}.`), hubMessageFor: [400, 403, 503] },
    );
    if (!res.ok) return;
    setText('');
    toast.success(`${username} blacklisted`);
    router.refresh();
  }

  return (
    <form onSubmit={(e) => void submit(e)} noValidate className="flex flex-col gap-2">
      <Label htmlFor={`${id}-username`}>Blacklist a Discord username</Label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          id={`${id}-username`}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="username"
          maxLength={64}
          value={text}
          disabled={pending}
          onChange={(e) => {
            setError(null);
            setText(e.target.value);
          }}
          aria-invalid={fieldError ? true : undefined}
          aria-describedby={fieldError ? `${id}-error` : undefined}
          className="sm:max-w-xs"
        />
        <Button type="submit" variant="outline" disabled={pending || username === null}>
          {pending ? (
            <LoaderCircleIcon aria-hidden className="animate-spin" />
          ) : (
            <BanIcon aria-hidden data-icon="inline-start" />
          )}
          Blacklist
        </Button>
      </div>
      <FieldError id={`${id}-error`} message={fieldError} />
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </form>
  );
}

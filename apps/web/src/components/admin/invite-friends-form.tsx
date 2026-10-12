'use client';
/**
 * Admin → Settings → Invite a friend (D-117): whether members may invite friends who are not in the
 * guild, and how many each may have. Saved together with PUT /api/app/admin/invite-friends; Save is
 * enabled only for a valid change. Off stops new invites; friends already in keep their access.
 */
import type { InviteFriendsSettings } from '@hub/core';
import { LoaderCircleIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { FieldError } from '@/components/common/field-error';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useApiRequest } from '@/lib/use-api-request';
import { INVITE_FRIENDS_API_PATH, adminFailure } from './admin-model';

export interface InviteFriendsFormProps {
  initial: InviteFriendsSettings;
  min: number;
  max: number;
  guildName: string;
}

export function InviteFriendsForm({ initial, min, max, guildName }: InviteFriendsFormProps) {
  const router = useRouter();
  const id = useId();
  const [saved, setSaved] = useState<InviteFriendsSettings>(initial);
  const [enabled, setEnabled] = useState(initial.enabled);
  const [maxText, setMaxText] = useState(String(initial.maxPerMember));
  const { pending, error, setError, send } = useApiRequest();

  const maxPerMember = /^\d+$/.test(maxText.trim()) ? Number(maxText.trim()) : NaN;
  const fieldError =
    Number.isInteger(maxPerMember) && maxPerMember >= min && maxPerMember <= max
      ? undefined
      : `A whole number from ${min} to ${max}.`;
  const dirty = enabled !== saved.enabled || maxPerMember !== saved.maxPerMember;

  async function save(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (fieldError || !dirty) return;
    const res = await send(
      INVITE_FRIENDS_API_PATH,
      { method: 'PUT', json: { enabled, maxPerMember } },
      adminFailure("Couldn't save Invite a friend. Try again in a moment."),
    );
    if (!res.ok) return;
    setSaved({ enabled, maxPerMember });
    toast.success(enabled ? 'Invite a friend saved' : 'Invite a friend turned off');
    router.refresh();
  }

  return (
    <form onSubmit={(e) => void save(e)} noValidate>
      <Card>
        <CardHeader>
          <CardTitle>
            <h3>Invite a friend</h3>
          </CardTitle>
          <CardDescription>
            Members of {guildName} can let friends who aren&apos;t in it into the hub, by their
            Discord username. Friends can&apos;t invite anyone themselves, and lose access when the
            member who invited them leaves. Members invite on their Friends page; blacklist a friend
            on Admin → Friends.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          <div className="flex items-start justify-between gap-4">
            <div className="flex flex-col gap-1">
              <Label htmlFor={`${id}-enabled`}>Let members invite friends</Label>
              <p id={`${id}-enabled-help`} className="text-sm text-muted-foreground">
                Off stops new invites. Friends already in keep their access until they are removed
                or blacklisted.
              </p>
            </div>
            <Switch
              id={`${id}-enabled`}
              checked={enabled}
              disabled={pending}
              onCheckedChange={(checked) => {
                setError(null);
                setEnabled(checked);
              }}
              aria-describedby={`${id}-enabled-help`}
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor={`${id}-max`}>Friends per member</Label>
            <Input
              id={`${id}-max`}
              inputMode="numeric"
              autoComplete="off"
              className="w-24"
              value={maxText}
              disabled={pending}
              onChange={(e) => {
                setError(null);
                setMaxText(e.target.value);
              }}
              aria-invalid={fieldError ? true : undefined}
              aria-describedby={`${id}-max-help${fieldError ? ` ${id}-max-error` : ''}`}
            />
            <p id={`${id}-max-help`} className="text-sm text-muted-foreground">
              Invites count whether or not the friend has signed in. Lowering it removes nobody;
              members over it can&apos;t invite until they are under it.
            </p>
            <FieldError id={`${id}-max-error`} message={fieldError} />
          </div>

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </CardContent>
        <CardFooter className="justify-end">
          <Button type="submit" disabled={pending || !dirty || fieldError !== undefined}>
            {pending && <LoaderCircleIcon aria-hidden className="animate-spin" />}
            Save
          </Button>
        </CardFooter>
      </Card>
    </form>
  );
}

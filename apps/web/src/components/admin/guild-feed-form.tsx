'use client';
/**
 * Admin → Settings → Guild activity (D-81): the guild feed's minimum loot value (whole gp or 100k /
 * 1.5m shorthand, as on the Settings page) and whether level-ups past 99 are shown. Saved together
 * with PUT /api/app/admin/guild-feed; Save is enabled only for a valid change.
 */
import type { GuildFeedFilter } from '@hub/core';
import { LoaderCircleIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { MinLootField } from '@/components/settings/min-loot-field';
import { parseMinLootValue } from '@/components/settings/settings-model';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useApiRequest } from '@/lib/use-api-request';
import { GUILD_FEED_API_PATH, adminFailure } from './admin-model';

const LOOT_PRESETS = [0, 10_000, 100_000, 1_000_000];

export interface GuildFeedFormProps {
  initial: GuildFeedFilter;
  /** Highest minimum loot value the server accepts. */
  maxMinLootValue: number;
}

export function GuildFeedForm({ initial, maxMinLootValue }: GuildFeedFormProps) {
  const router = useRouter();
  const id = useId();
  const [saved, setSaved] = useState<GuildFeedFilter>(initial);
  const [minLootText, setMinLootText] = useState(String(initial.minLootValue));
  const [showVirtualLevels, setShowVirtualLevels] = useState(initial.showVirtualLevels);
  const { pending, error, setError, send } = useApiRequest();

  const minLoot = parseMinLootValue(minLootText, maxMinLootValue);
  const dirty = minLoot !== saved.minLootValue || showVirtualLevels !== saved.showVirtualLevels;

  async function save(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (minLoot === null || !dirty) return;
    const res = await send(
      GUILD_FEED_API_PATH,
      { method: 'PUT', json: { minLootValue: minLoot, showVirtualLevels } },
      adminFailure("Couldn't save the guild feed settings. Try again in a moment."),
    );
    if (!res.ok) return;
    const next = { minLootValue: minLoot, showVirtualLevels };
    setSaved(next);
    setMinLootText(String(minLoot));
    toast.success('Guild feed settings saved');
    router.refresh();
  }

  return (
    <form onSubmit={(e) => void save(e)} noValidate>
      <Card>
        <CardHeader>
          <CardTitle>
            <h3>Guild activity</h3>
          </CardTitle>
          <CardDescription>
            What the guild page&apos;s activity feed leaves out. Nothing is deleted: account pages,
            toasts and the API still show every event.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          <MinLootField
            id={`${id}-min-loot`}
            value={minLootText}
            onChange={(value) => {
              setError(null);
              setMinLootText(value);
            }}
            max={maxMinLootValue}
            presets={LOOT_PRESETS}
            help={{
              any: 'Every loot drop and loot chest is shown.',
              below: (amount) =>
                `Loot drops and loot chests below ${amount} gp are left out. Other events are not affected.`,
            }}
            flagUnreadable
            disabled={pending}
          />

          <div className="flex items-start justify-between gap-4">
            <div className="flex flex-col gap-1">
              <Label htmlFor={`${id}-virtual`}>Show virtual levels</Label>
              <p id={`${id}-virtual-help`} className="text-sm text-muted-foreground">
                Level-ups past 99 (up to 126, from XP). Combat level is always shown.
              </p>
            </div>
            <Switch
              id={`${id}-virtual`}
              checked={showVirtualLevels}
              disabled={pending}
              onCheckedChange={(checked) => {
                setError(null);
                setShowVirtualLevels(checked);
              }}
              aria-describedby={`${id}-virtual-help`}
            />
          </div>

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </CardContent>
        <CardFooter className="justify-end">
          <Button type="submit" disabled={pending || !dirty || minLoot === null}>
            {pending && <LoaderCircleIcon aria-hidden className="animate-spin" />}
            Save
          </Button>
        </CardFooter>
      </Card>
    </form>
  );
}

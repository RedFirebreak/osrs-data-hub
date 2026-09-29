'use client';
/**
 * The Settings form: the live toast filter (on/off, event types, minimum loot value, own accounts
 * only) and the time zone. Saves only what changed with PATCH /api/app/settings; the server's field
 * errors (400 details) are shown next to their fields. The live stream applies the toast filter it
 * had when it opened, so after a filter change the stream is reopened (LiveProvider reconnect).
 */
import { formatGp } from '@hub/core';
import type { UserSettings } from '@hub/server';
import { LoaderCircleIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useId, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useLiveControls } from '@/components/live/live-provider';
import { useHydrated } from '@/components/live/use-now';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import {
  buildPatch,
  changesToastFilter,
  fieldErrorsFrom,
  formStateFrom,
  groupTimeZones,
  parseMinLootValue,
  type FieldErrors,
  type SettingsFormState,
} from './settings-model';

export interface SettingsFormProps {
  initial: UserSettings;
  /** Stored event types with their labels, in display order. */
  eventTypes: { value: string; label: string }[];
  /** IANA names for the picker (supportedTimeZones). */
  timeZones: string[];
  /** Highest minimum loot value the server accepts. */
  maxMinLootValue: number;
}

const LOOT_PRESETS = [0, 10_000, 100_000, 1_000_000, 10_000_000];

interface ErrorBody {
  error?: { message?: string; details?: unknown };
}

function FieldError({ id, message }: { id: string; message: string | undefined }) {
  if (!message) return null;
  return (
    <p id={id} className="text-sm text-destructive">
      {message}
    </p>
  );
}

export function SettingsForm({
  initial,
  eventTypes,
  timeZones,
  maxMinLootValue,
}: SettingsFormProps) {
  const router = useRouter();
  const { reconnect } = useLiveControls();
  const hydrated = useHydrated();
  const id = useId();
  const typeValues = useMemo(() => eventTypes.map((t) => t.value), [eventTypes]);
  const groups = useMemo(() => groupTimeZones(timeZones), [timeZones]);
  const [saved, setSaved] = useState<UserSettings>(initial);
  const [state, setState] = useState<SettingsFormState>(() => formStateFrom(initial, typeValues));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [saving, setSaving] = useState(false);

  const { patch, errors: clientErrors } = buildPatch(state, saved, typeValues, maxMinLootValue);
  const dirty = Object.keys(patch).length > 0 || Object.keys(clientErrors).length > 0;
  const minLoot = parseMinLootValue(state.minLootValue, maxMinLootValue);
  const browserZone = hydrated ? Intl.DateTimeFormat().resolvedOptions().timeZone : null;
  const offerBrowserZone =
    browserZone !== null && browserZone !== state.timezone && timeZones.includes(browserZone);

  function update(changes: Partial<SettingsFormState>): void {
    setState((s) => ({ ...s, ...changes }));
    setErrors((e) => {
      const next = { ...e };
      if ('minLootValue' in changes) delete next.toastMinLootValue;
      if ('types' in changes || 'allTypes' in changes) delete next.toastTypes;
      if ('timezone' in changes) delete next.timezone;
      return next;
    });
  }

  function toggleType(type: string, checked: boolean): void {
    const set = new Set(state.types);
    if (checked) set.add(type);
    else set.delete(type);
    update({ types: typeValues.filter((t) => set.has(t)) });
  }

  async function save(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (Object.keys(clientErrors).length > 0) {
      setErrors(clientErrors);
      return;
    }
    if (Object.keys(patch).length === 0) return;
    setSaving(true);
    setErrors({});
    try {
      const res = await fetch('/api/app/settings', {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const body = (await res.json().catch(() => null)) as
        ({ settings?: UserSettings } & ErrorBody) | null;
      if (res.ok && body?.settings) {
        setSaved(body.settings);
        setState(formStateFrom(body.settings, typeValues));
        toast.success('Settings saved');
        // The stream applies the filter it opened with (LiveProvider → reopen with Last-Event-ID).
        if (changesToastFilter(patch)) reconnect();
        // "Today" on the dashboard is cut in the time zone.
        if (patch.timezone !== undefined) router.refresh();
        return;
      }
      if (res.status === 400) {
        const fieldErrors = fieldErrorsFrom(body?.error?.details);
        setErrors(fieldErrors);
        toast.error(
          Object.keys(fieldErrors).length > 0
            ? 'Some settings are invalid. Check the highlighted fields.'
            : (body?.error?.message ?? "Couldn't save your settings."),
        );
        return;
      }
      if (res.status === 401) {
        toast.error('Your session has ended. Sign in again.');
        router.refresh();
        return;
      }
      toast.error(body?.error?.message ?? "Couldn't save your settings. Try again in a moment.");
    } catch {
      toast.error("Couldn't reach the hub. Check your connection and try again.");
    } finally {
      setSaving(false);
    }
  }

  const shownErrors: FieldErrors = { ...errors };
  const typesNone = !state.allTypes && state.types.length === 0;

  return (
    <form onSubmit={(e) => void save(e)} noValidate className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Live toasts</h2>
          </CardTitle>
          <CardDescription>
            Pop-ups on the right when something happens to an account you can see. They only cover
            events the players&apos; plugins send, and never events older than 15 minutes.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          <div className="flex items-start justify-between gap-4">
            <div className="flex flex-col gap-1">
              <Label htmlFor={`${id}-enabled`}>Show event toasts</Label>
              <p id={`${id}-enabled-help`} className="text-sm text-muted-foreground">
                Turn off to keep events in the feeds only.
              </p>
            </div>
            <Switch
              id={`${id}-enabled`}
              checked={state.toastsEnabled}
              onCheckedChange={(checked) => update({ toastsEnabled: checked })}
              aria-describedby={`${id}-enabled-help`}
            />
          </div>

          <fieldset
            disabled={!state.toastsEnabled}
            className={cn('flex flex-col gap-6', !state.toastsEnabled && 'opacity-60')}
          >
            <legend className="sr-only">Toast filters</legend>
            <div role="group" aria-labelledby={`${id}-types-label`} className="flex flex-col gap-3">
              <span id={`${id}-types-label`} className="text-sm font-medium">
                Event types
              </span>
              <div className="flex items-center gap-2">
                <Checkbox
                  id={`${id}-all-types`}
                  checked={state.allTypes}
                  onCheckedChange={(checked) => update({ allTypes: checked === true })}
                />
                <Label htmlFor={`${id}-all-types`} className="font-normal">
                  All event types, including new ones
                </Label>
              </div>
              {!state.allTypes && (
                <div
                  role="group"
                  aria-label="Event types to toast"
                  aria-describedby={shownErrors.toastTypes ? `${id}-types-error` : undefined}
                  className="grid gap-2 pl-6 sm:grid-cols-2"
                >
                  {eventTypes.map((type) => {
                    const boxId = `${id}-type-${type.value}`;
                    return (
                      <div key={type.value} className="flex items-center gap-2">
                        <Checkbox
                          id={boxId}
                          checked={state.types.includes(type.value)}
                          onCheckedChange={(checked) => toggleType(type.value, checked === true)}
                          aria-invalid={shownErrors.toastTypes ? true : undefined}
                        />
                        <Label htmlFor={boxId} className="font-normal">
                          {type.label}
                        </Label>
                      </div>
                    );
                  })}
                </div>
              )}
              {typesNone && (
                <p className="pl-6 text-sm text-muted-foreground">
                  No types selected: you won&apos;t get any event toasts.
                </p>
              )}
              <FieldError id={`${id}-types-error`} message={shownErrors.toastTypes} />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor={`${id}-min-loot`}>Minimum loot value</Label>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <Input
                  id={`${id}-min-loot`}
                  inputMode="numeric"
                  autoComplete="off"
                  className="sm:max-w-44"
                  value={state.minLootValue}
                  onChange={(e) => update({ minLootValue: e.target.value })}
                  aria-invalid={shownErrors.toastMinLootValue ? true : undefined}
                  aria-describedby={`${id}-min-loot-help${shownErrors.toastMinLootValue ? ` ${id}-min-loot-error` : ''}`}
                />
                <div className="flex flex-wrap gap-1.5" role="group" aria-label="Quick values">
                  {LOOT_PRESETS.map((value) => (
                    <Button
                      key={value}
                      type="button"
                      size="xs"
                      variant={minLoot === value ? 'secondary' : 'outline'}
                      onClick={() => update({ minLootValue: String(value) })}
                    >
                      {value === 0 ? 'Any' : formatGp(value)}
                    </Button>
                  ))}
                </div>
              </div>
              <p id={`${id}-min-loot-help`} className="text-sm text-muted-foreground">
                {minLoot === null
                  ? 'Whole gp, or shorthand like 100k or 1.5m (decimals with a point).'
                  : minLoot === 0
                    ? 'Every loot drop and loot chest can toast.'
                    : `Loot drops and loot chests below ${formatGp(minLoot)} gp don't toast. Other events are not affected.`}
              </p>
              <FieldError id={`${id}-min-loot-error`} message={shownErrors.toastMinLootValue} />
            </div>

            <div className="flex items-start justify-between gap-4">
              <div className="flex flex-col gap-1">
                <Label htmlFor={`${id}-own`}>Only my own accounts</Label>
                <p id={`${id}-own-help`} className="text-sm text-muted-foreground">
                  Toast only events of accounts you own or play on (contributor).
                </p>
              </div>
              <Switch
                id={`${id}-own`}
                checked={state.ownAccountsOnly}
                onCheckedChange={(checked) => update({ ownAccountsOnly: checked })}
                aria-describedby={`${id}-own-help`}
              />
            </div>
          </fieldset>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Time zone</h2>
          </CardTitle>
          <CardDescription>
            Decides where &quot;today&quot; starts for gains on your dashboard.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <Label htmlFor={`${id}-tz`}>Time zone</Label>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <select
              id={`${id}-tz`}
              value={state.timezone}
              onChange={(e) => update({ timezone: e.target.value })}
              aria-invalid={shownErrors.timezone ? true : undefined}
              aria-describedby={shownErrors.timezone ? `${id}-tz-error` : undefined}
              className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive sm:max-w-80 dark:bg-input/30 [&_optgroup]:bg-popover [&_option]:bg-popover"
            >
              {!timeZones.includes(state.timezone) && (
                <option value={state.timezone}>{state.timezone}</option>
              )}
              {groups.map((group) => (
                <optgroup key={group.label} label={group.label}>
                  {group.zones.map((zone) => (
                    <option key={zone.value} value={zone.value}>
                      {zone.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            {offerBrowserZone && browserZone && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => update({ timezone: browserZone })}
              >
                Use {browserZone.replace(/_/g, ' ')}
              </Button>
            )}
          </div>
          <FieldError id={`${id}-tz-error`} message={shownErrors.timezone} />
        </CardContent>
        <CardFooter className="flex flex-wrap items-center justify-end gap-3">
          <span className="mr-auto text-sm text-muted-foreground" aria-live="polite">
            {dirty ? 'You have unsaved changes.' : 'All changes saved.'}
          </span>
          <Button
            type="button"
            variant="ghost"
            disabled={!dirty || saving}
            onClick={() => {
              setState(formStateFrom(saved, typeValues));
              setErrors({});
            }}
          >
            Reset
          </Button>
          <Button type="submit" disabled={!dirty || saving}>
            {saving && <LoaderCircleIcon aria-hidden className="animate-spin" />}
            {saving ? 'Saving…' : 'Save settings'}
          </Button>
        </CardFooter>
      </Card>
    </form>
  );
}

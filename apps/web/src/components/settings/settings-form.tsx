'use client';
/**
 * The Settings form: the live toast filter (on/off, event types, minimum loot value, own accounts
 * only) and the time zone. Saves only what changed with PATCH /api/app/settings; the server's field
 * errors (400 details) are shown next to their fields. The live stream applies the toast filter it
 * had when it opened, so after a filter change the stream is reopened (LiveProvider reconnect).
 */
import type { UserSettings } from '@hub/server';
import { LoaderCircleIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useId, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { FieldError } from '@/components/common/field-error';
import { NativeSelect } from '@/components/common/native-select';
import { useLiveControls } from '@/components/live/live-provider';
import { useHydrated } from '@/components/time/use-now';
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
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  apiErrorDetails,
  apiErrorMessage,
  failureMessage,
  fieldErrorsFrom,
  type FailureOptions,
} from '@/lib/api-client';
import { useApiRequest } from '@/lib/use-api-request';
import { cn } from '@/lib/utils';
import { MinLootField } from './min-loot-field';
import {
  SETTINGS_FIELDS,
  buildPatch,
  changesToastFilter,
  formStateFrom,
  groupTimeZones,
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

/** A refused save says why in the hub's own words, whatever the status. */
const SAVE_FAILURE: FailureOptions = {
  fallback: "Couldn't save your settings. Try again in a moment.",
  hubMessageFor: 'any',
};

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
  const { pending: saving, send } = useApiRequest();

  const { patch, errors: clientErrors } = buildPatch(state, saved, typeValues, maxMinLootValue);
  const dirty = Object.keys(patch).length > 0 || Object.keys(clientErrors).length > 0;
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
    setErrors({});
    const res = await send('/api/app/settings', { method: 'PATCH', json: patch }, SAVE_FAILURE);
    const settings = (res.body as { settings?: UserSettings } | null)?.settings;
    if (res.ok && settings) {
      setSaved(settings);
      setState(formStateFrom(settings, typeValues));
      toast.success('Settings saved');
      // The stream applies the filter it opened with (LiveProvider → reopen with Last-Event-ID).
      if (changesToastFilter(patch)) reconnect();
      // "Today" in the gains is cut in the time zone.
      if (patch.timezone !== undefined) router.refresh();
      return;
    }
    if (res.status === 400) {
      const fieldErrors = fieldErrorsFrom(apiErrorDetails(res.body), SETTINGS_FIELDS);
      setErrors(fieldErrors);
      toast.error(
        Object.keys(fieldErrors).length > 0
          ? 'Some settings are invalid. Check the highlighted fields.'
          : apiErrorMessage(res.body, "Couldn't save your settings."),
      );
      return;
    }
    toast.error(failureMessage(res.status, res.body, SAVE_FAILURE));
  }

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
                  aria-describedby={errors.toastTypes ? `${id}-types-error` : undefined}
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
                          aria-invalid={errors.toastTypes ? true : undefined}
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
              <FieldError id={`${id}-types-error`} message={errors.toastTypes} />
            </div>

            <MinLootField
              id={`${id}-min-loot`}
              value={state.minLootValue}
              onChange={(minLootValue) => update({ minLootValue })}
              max={maxMinLootValue}
              presets={LOOT_PRESETS}
              help={{
                any: 'Every loot drop and loot chest can toast.',
                below: (amount) =>
                  `Loot drops and loot chests below ${amount} gp don't toast. Other events are not affected.`,
              }}
              error={errors.toastMinLootValue}
            />

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
            Decides where &quot;today&quot; starts for the gains and charts you see.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <Label htmlFor={`${id}-tz`}>Time zone</Label>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <NativeSelect
              id={`${id}-tz`}
              value={state.timezone}
              onChange={(e) => update({ timezone: e.target.value })}
              aria-invalid={errors.timezone ? true : undefined}
              aria-describedby={errors.timezone ? `${id}-tz-error` : undefined}
              className="sm:max-w-80 [&_optgroup]:bg-popover"
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
            </NativeSelect>
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
          <FieldError id={`${id}-tz-error`} message={errors.timezone} />
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

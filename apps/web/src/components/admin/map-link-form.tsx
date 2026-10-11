'use client';
/**
 * Admin → Settings → Live map (D-115): whether the top bar shows "Map", and the map's address. Saved
 * together with PUT /api/app/admin/map-link; Save is enabled only for a valid change. The address is
 * kept while the link is off, and turning it on needs one.
 */
import { parseMapUrl, type MapLink } from '@hub/core';
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
import { MAP_LINK_API_PATH, adminFailure } from './admin-model';

export interface MapLinkFormProps {
  initial: MapLink;
}

export function MapLinkForm({ initial }: MapLinkFormProps) {
  const router = useRouter();
  const id = useId();
  const [saved, setSaved] = useState<MapLink>(initial);
  const [enabled, setEnabled] = useState(initial.enabled);
  const [urlText, setUrlText] = useState(initial.url ?? '');
  const { pending, error, setError, send } = useApiRequest();

  const empty = urlText.trim() === '';
  const url = empty ? null : parseMapUrl(urlText);
  const fieldError =
    !empty && url === null
      ? 'Enter an http or https address, such as https://map.example.com.'
      : enabled && empty
        ? "Add the map's address to show the link."
        : undefined;
  const dirty = enabled !== saved.enabled || url !== saved.url;

  async function save(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (fieldError || !dirty) return;
    const res = await send(
      MAP_LINK_API_PATH,
      { method: 'PUT', json: { enabled, url } },
      adminFailure("Couldn't save the map link. Try again in a moment."),
    );
    if (!res.ok) return;
    setSaved({ enabled, url });
    setUrlText(url ?? '');
    toast.success(enabled ? 'Map link saved' : 'Map link turned off');
    router.refresh();
  }

  return (
    <form onSubmit={(e) => void save(e)} noValidate>
      <Card>
        <CardHeader>
          <CardTitle>
            <h3>Live map</h3>
          </CardTitle>
          <CardDescription>
            A link to the guild&apos;s live map in the top bar, next to Guild, for everyone signed
            in. The map is its own site with its own sign-in; it opens in a new tab.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          <div className="flex items-start justify-between gap-4">
            <div className="flex flex-col gap-1">
              <Label htmlFor={`${id}-enabled`}>Show Map in the top bar</Label>
              <p id={`${id}-enabled-help`} className="text-sm text-muted-foreground">
                Off keeps the address below for later.
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
            <Label htmlFor={`${id}-url`}>Map address</Label>
            <Input
              id={`${id}-url`}
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              placeholder="https://map.example.com"
              value={urlText}
              disabled={pending}
              onChange={(e) => {
                setError(null);
                setUrlText(e.target.value);
              }}
              aria-invalid={fieldError ? true : undefined}
              aria-describedby={`${id}-url-help${fieldError ? ` ${id}-url-error` : ''}`}
            />
            <p id={`${id}-url-help`} className="text-sm text-muted-foreground">
              Where the map is reached from a browser, as http:// or https://.
            </p>
            <FieldError id={`${id}-url-error`} message={fieldError} />
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

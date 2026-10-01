'use client';
/**
 * A device's name with inline rename (handoff §6.3): the name as the card's h3 with a "Rename"
 * button; editing shows an input (Enter saves, Escape cancels) that PATCHes
 * /api/app/devices/[id]. The label the server stored (trimmed, cut to `labelMax` characters, empty →
 * no label) is shown at once, and the page is refreshed. Focus returns to the Rename button
 * afterwards, and to the input when saving failed (the input is disabled while saving, which drops
 * the focus).
 */
import { CheckIcon, LoaderCircleIcon, PencilIcon, XIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useApiRequest } from '@/lib/use-api-request';
import { cn } from '@/lib/utils';
import { UNNAMED_DEVICE, deviceApiPath, deviceFailure, deviceName } from './device-model';

export interface DeviceLabelEditorProps {
  deviceId: string;
  label: string | null;
  /** Longest label the hub keeps (DEVICE_LABEL_MAX). */
  labelMax: number;
  className?: string;
}

export function DeviceLabelEditor({
  deviceId,
  label,
  labelMax,
  className,
}: DeviceLabelEditorProps) {
  const router = useRouter();
  const id = useId();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const { pending: saving, error, setError, send } = useApiRequest();
  /**
   * The label this editor saved and the `label` prop it replaced: shown only while the prop is still
   * that old value, i.e. until the refreshed page brings the new one. After that the prop wins again,
   * so a later rename elsewhere (another tab, an admin) shows up on the next refresh.
   */
  const [saved, setSaved] = useState<{ label: string | null; replaced: string | null } | null>(
    null,
  );
  const inputRef = useRef<HTMLInputElement>(null);
  const renameRef = useRef<HTMLButtonElement>(null);
  const refocus = useRef<'input' | 'rename' | null>(null);

  const current = saved && saved.replaced === label ? saved.label : label;
  const name = deviceName(current);

  useEffect(() => {
    // After the input is enabled again: a disabled element can't take the focus.
    if (saving) return;
    if (refocus.current === 'input') inputRef.current?.select();
    if (refocus.current === 'rename') renameRef.current?.focus();
    refocus.current = null;
  }, [editing, saving]);

  function startEditing(): void {
    setValue(current ?? '');
    setError(null);
    refocus.current = 'input';
    setEditing(true);
  }

  function stopEditing(): void {
    setError(null);
    refocus.current = 'rename';
    setEditing(false);
  }

  async function save(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const next = value.trim() === '' ? null : value;
    if ((next?.trim() ?? null) === (current ?? null)) {
      stopEditing();
      return;
    }
    // Back to the input when saving fails; set before the request, so it is in place whenever the
    // input is enabled again (a success replaces it with the Rename button, stopEditing).
    refocus.current = 'input';
    const res = await send(
      deviceApiPath(deviceId),
      { method: 'PATCH', json: { label: next } },
      deviceFailure('rename'),
    );
    if (!res.ok) return;
    const body = res.body as { device?: { label?: string | null } } | null;
    const stored = body?.device?.label ?? null;
    setSaved({ label: stored, replaced: label });
    stopEditing();
    toast.success(`Renamed to ${deviceName(stored)}`);
    router.refresh();
  }

  if (!editing) {
    return (
      <div className={cn('flex min-w-0 items-center gap-1', className)}>
        <h3
          className={cn(
            'truncate text-base font-semibold',
            current === null && 'font-medium text-muted-foreground italic',
          )}
        >
          {name}
        </h3>
        <Button
          ref={renameRef}
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={startEditing}
          aria-label={`Rename ${name}`}
          title="Rename"
        >
          <PencilIcon aria-hidden />
        </Button>
      </div>
    );
  }

  return (
    <form
      onSubmit={(e) => void save(e)}
      className={cn('flex min-w-0 flex-1 flex-col gap-1', className)}
      noValidate
    >
      <label htmlFor={`${id}-label`} className="sr-only">
        Device name
      </label>
      <div className="flex min-w-0 items-center gap-1">
        <Input
          ref={inputRef}
          id={`${id}-label`}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              stopEditing();
            }
          }}
          maxLength={labelMax}
          placeholder={UNNAMED_DEVICE}
          autoComplete="off"
          disabled={saving}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          className="h-8 max-w-72"
        />
        <Button type="submit" size="icon-sm" disabled={saving} aria-label="Save name">
          {saving ? (
            <LoaderCircleIcon aria-hidden className="animate-spin" />
          ) : (
            <CheckIcon aria-hidden />
          )}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={stopEditing}
          disabled={saving}
          aria-label="Cancel renaming"
        >
          <XIcon aria-hidden />
        </Button>
      </div>
      {error && (
        <p id={`${id}-error`} role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </form>
  );
}

'use client';
/**
 * "Create integration key" on Admin → Integrations (D-88): a dialog with the key's name, the
 * categories it may read (nothing preselected), its rate limit (blank = the service default) and its
 * expiry; POST /api/app/admin/service-keys. On success the dialog shows the key once, read-only with
 * a Copy button and a clear warning, and can only be left with "Done", which reloads the list
 * (router.refresh()). The hub keeps only a hash: the key can't be shown again. After a creation the
 * focus goes to the list's heading (`listHeadingId`) or the page's h1, since the refresh re-renders
 * the trigger's surroundings.
 *
 * Field errors from the server's 400 `details` are shown next to their fields.
 */
import { CATEGORIES, CATEGORY_LABELS, type Category } from '@hub/core';
import { KeyRoundIcon, LoaderCircleIcon, PlusIcon, TriangleAlertIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { adminFailureMessage } from '@/components/admin/admin-model';
import { EXPIRY_OPTIONS, createdKeyFrom } from '@/components/api-keys/api-key-model';
import { CopyButton } from '@/components/onboarding/copy-button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { mainHeading, useFocusReturn } from '@/lib/focus';
import {
  emptyServiceKeyForm,
  serviceKeyBody,
  serviceKeyFieldErrors,
  validateServiceKeyForm,
  type ServiceKeyErrors,
  type ServiceKeyForm,
} from './service-key-model';

export interface CreateServiceKeyDialogProps {
  /** Longest key name (API_KEY_NAME_MAX). */
  nameMax: number;
  /** The default requests per minute of a service key (SERVICE_KEY_RATE_LIMIT). */
  rateLimitDefault: number;
  /** The highest rate limit an admin may set (MAX_KEY_RATE_LIMIT). */
  rateLimitMax: number;
  /** Absolute base URL of the API (APP_URL + /api/v1), for the "try it" line. */
  apiBase: string;
  /** Bigger trigger for the empty state. */
  size?: 'default' | 'lg';
  /** Id of the heading of the list the new key shows up in: it gets the focus after "Done". */
  listHeadingId?: string;
}

function FieldError({ id, message }: { id: string; message: string | undefined }) {
  if (!message) return null;
  return (
    <p id={id} className="text-sm text-destructive">
      {message}
    </p>
  );
}

export function CreateServiceKeyDialog({
  nameMax,
  rateLimitDefault,
  rateLimitMax,
  apiBase,
  size = 'default',
  listHeadingId,
}: CreateServiceKeyDialogProps) {
  const id = useId();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<ServiceKeyForm>(emptyServiceKeyForm);
  const [errors, setErrors] = useState<ServiceKeyErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [created, setCreated] = useState<{ key: string; name: string } | null>(null);
  const focusReturn = useFocusReturn();

  function update(patch: Partial<ServiceKeyForm>): void {
    setForm((f) => ({ ...f, ...patch }));
  }

  function toggleCategory(category: Category, on: boolean): void {
    setForm((f) => ({
      ...f,
      categories: on
        ? [...new Set([...f.categories, category])]
        : f.categories.filter((c) => c !== category),
    }));
  }

  function reset(): void {
    setForm(emptyServiceKeyForm());
    setErrors({});
    setFormError(null);
    setCreated(null);
  }

  function onOpenChange(next: boolean): void {
    if (pending) return;
    if (!next && created) {
      focusReturn.set(
        () => (listHeadingId ? document.getElementById(listHeadingId) : null),
        mainHeading,
      );
      router.refresh();
    }
    if (!next) reset();
    setOpen(next);
  }

  async function submit(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    const invalid = validateServiceKeyForm(form, { nameMax, rateLimitMax });
    setErrors(invalid);
    setFormError(null);
    if (Object.keys(invalid).length > 0) return;
    setPending(true);
    try {
      const res = await fetch('/api/app/admin/service-keys', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(serviceKeyBody(form)),
      });
      const body: unknown = await res.json().catch(() => null);
      const key = res.status === 201 ? createdKeyFrom(body) : null;
      if (key) {
        setCreated({ key, name: form.name.trim() });
        toast.success('Integration key created');
        return;
      }
      const details =
        res.status === 400 && typeof body === 'object' && body !== null
          ? (body as { error?: { details?: unknown } }).error?.details
          : undefined;
      const fieldErrors = serviceKeyFieldErrors(details);
      setErrors(fieldErrors);
      if (Object.keys(fieldErrors).length === 0) {
        setFormError(
          adminFailureMessage(res.status, body, "Couldn't create the key. Try again in a moment."),
        );
      }
      if (res.status === 401) router.refresh();
    } catch {
      setFormError("Couldn't reach the hub. Check your connection and try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button type="button" size={size}>
          <PlusIcon aria-hidden data-icon="inline-start" />
          Create integration key
        </Button>
      </DialogTrigger>
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg"
        showCloseButton={!pending}
        onCloseAutoFocus={focusReturn.onCloseAutoFocus}
        onInteractOutside={(e) => {
          if (created || pending) e.preventDefault();
        }}
        onEscapeKeyDown={(e) => {
          if (created || pending) e.preventDefault();
        }}
      >
        {created ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <KeyRoundIcon aria-hidden className="size-4" />
                Copy the new key
              </DialogTitle>
              <DialogDescription>
                {created.name}: paste it into the integration&apos;s configuration.
              </DialogDescription>
            </DialogHeader>
            <Alert className="border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-200">
              <TriangleAlertIcon aria-hidden />
              <AlertTitle>You won&apos;t see this key again</AlertTitle>
              <AlertDescription className="text-current">
                The hub stores only a fingerprint of it. Copy it now and keep it in the
                integration&apos;s secrets. If it leaks, revoke it and create a new one.
              </AlertDescription>
            </Alert>
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${id}-key`}>Integration key</Label>
              <div className="flex items-center gap-2">
                <Input
                  id={`${id}-key`}
                  readOnly
                  value={created.key}
                  onFocus={(e) => e.currentTarget.select()}
                  className="font-mono text-xs"
                  spellCheck={false}
                  autoComplete="off"
                />
                <CopyButton value={created.key} what="integration key" />
              </div>
              <p className="text-xs text-muted-foreground">
                Try it:{' '}
                <code className="break-all">
                  curl -H &quot;Authorization: Bearer &lt;key&gt;&quot; {apiBase}/me
                </code>
              </p>
            </div>
            <DialogFooter>
              <Button type="button" onClick={() => onOpenChange(false)}>
                Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={(e) => void submit(e)} noValidate className="flex flex-col gap-5">
            <DialogHeader>
              <DialogTitle>Create an integration key</DialogTitle>
              <DialogDescription>
                For the guild&apos;s own services, such as its live map. The key belongs to nobody
                and reads exactly what every guild member can see: the accounts and categories
                shared with the guild.
              </DialogDescription>
            </DialogHeader>

            <div className="flex flex-col gap-2">
              <Label htmlFor={`${id}-name`}>Name</Label>
              <Input
                id={`${id}-name`}
                value={form.name}
                onChange={(e) => update({ name: e.target.value })}
                placeholder="Guild live map"
                autoComplete="off"
                aria-invalid={errors.name ? true : undefined}
                aria-describedby={errors.name ? `${id}-name-error` : `${id}-name-hint`}
              />
              {errors.name ? (
                <FieldError id={`${id}-name-error`} message={errors.name} />
              ) : (
                <p id={`${id}-name-hint`} className="text-xs text-muted-foreground">
                  The service that will use it. At most {nameMax} characters.
                </p>
              )}
            </div>

            <fieldset
              className="flex flex-col gap-3"
              aria-describedby={errors.categories ? `${id}-cat-error` : undefined}
            >
              <legend className="mb-1 text-sm font-medium">What it can read</legend>
              <div className="grid gap-3 sm:grid-cols-2">
                {CATEGORIES.map((category) => {
                  const boxId = `${id}-cat-${category}`;
                  return (
                    <div key={category} className="flex items-start gap-2">
                      <Checkbox
                        id={boxId}
                        checked={form.categories.includes(category)}
                        onCheckedChange={(checked) => toggleCategory(category, checked === true)}
                        aria-invalid={errors.categories ? true : undefined}
                        aria-describedby={`${boxId}-covers`}
                        className="mt-0.5"
                      />
                      <div className="flex min-w-0 flex-col gap-0.5">
                        <Label htmlFor={boxId} className="font-normal">
                          {CATEGORY_LABELS[category].label}
                        </Label>
                        <span id={`${boxId}-covers`} className="text-xs text-muted-foreground">
                          {CATEGORY_LABELS[category].covers}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
              <FieldError id={`${id}-cat-error`} message={errors.categories} />
            </fieldset>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-2">
                <Label htmlFor={`${id}-rate`}>Requests per minute</Label>
                <Input
                  id={`${id}-rate`}
                  inputMode="numeric"
                  value={form.rateLimit}
                  onChange={(e) => update({ rateLimit: e.target.value })}
                  placeholder={String(rateLimitDefault)}
                  autoComplete="off"
                  aria-invalid={errors.rateLimitPerMinute ? true : undefined}
                  aria-describedby={
                    errors.rateLimitPerMinute ? `${id}-rate-error` : `${id}-rate-hint`
                  }
                />
                {errors.rateLimitPerMinute ? (
                  <FieldError id={`${id}-rate-error`} message={errors.rateLimitPerMinute} />
                ) : (
                  <p id={`${id}-rate-hint`} className="text-xs text-muted-foreground">
                    Blank: {rateLimitDefault}. At most {rateLimitMax}. <code>/snapshot</code> stays
                    at 1 per second.
                  </p>
                )}
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor={`${id}-expiry`}>Expires</Label>
                <select
                  id={`${id}-expiry`}
                  value={form.expiry}
                  onChange={(e) => update({ expiry: e.target.value })}
                  aria-invalid={errors.expiresInDays ? true : undefined}
                  className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive dark:bg-input/30 [&_option]:bg-popover"
                >
                  {EXPIRY_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
                <FieldError id={`${id}-expiry-error`} message={errors.expiresInDays} />
              </div>
            </div>

            <p className="text-xs text-muted-foreground">
              Access follows the owners&apos; sharing settings on every request. Offboarding anyone,
              you included, never revokes an integration key: revoke it here.
            </p>

            {formError && (
              <p role="alert" className="text-sm text-destructive">
                {formError}
              </p>
            )}

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={pending}>
                {pending && <LoaderCircleIcon aria-hidden className="animate-spin" />}
                Create key
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

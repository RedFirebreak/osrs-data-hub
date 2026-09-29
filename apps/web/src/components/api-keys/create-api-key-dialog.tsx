'use client';
/**
 * "Create key" (D-69, D-76): a dialog with the key's name, the categories it may read (nothing
 * preselected: the user chooses), its account scope (every account the user can see, now and later,
 * or picked ones) and its expiry; POST /api/app/api-keys. On success the dialog shows the key once,
 * read-only with a Copy button and a clear warning, and can only be left with "Done", which reloads
 * the list (router.refresh()). The hub keeps only a hash: the key can't be shown again. The refresh
 * can take the trigger away (the empty state's button, or the header's when the limit is reached), so
 * after a creation the focus goes to the list's heading (`listHeadingId`) or the page's h1.
 *
 * Field errors from the server's 400 `details` are shown next to their fields; the user's accounts
 * come from the page (the same rule the server checks: what they can see right now, no admin
 * override).
 */
import { CATEGORIES, CATEGORY_LABELS, type Category } from '@hub/core';
import { KeyRoundIcon, LoaderCircleIcon, PlusIcon, TriangleAlertIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useId, useMemo, useState } from 'react';
import { toast } from 'sonner';
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
import { cn } from '@/lib/utils';
import {
  EXPIRY_OPTIONS,
  createFailureMessage,
  createKeyBody,
  createKeyFieldErrors,
  createdKeyFrom,
  emptyCreateForm,
  validateCreateForm,
  type CreateKeyErrors,
  type CreateKeyForm,
} from './api-key-model';

export interface PickableAccount {
  publicId: string;
  name: string;
}

export interface CreateApiKeyDialogProps {
  /** Accounts the user can see right now, sorted by name. */
  accounts: PickableAccount[];
  /** Longest key name (API_KEY_NAME_MAX). */
  nameMax: number;
  /** The user has the most active keys allowed: the trigger is disabled. */
  atLimit: boolean;
  /** Absolute base URL of the API (APP_URL + /api/v1), for the "try it" line. */
  apiBase: string;
  /** Bigger trigger for the empty state. */
  size?: 'default' | 'lg';
  /** Id of the heading of the list the new key shows up in: it gets the focus after "Done". */
  listHeadingId?: string;
}

/** Show a filter above the account list from this many accounts on. */
const FILTER_FROM = 8;

function FieldError({ id, message }: { id: string; message: string | undefined }) {
  if (!message) return null;
  return (
    <p id={id} className="text-sm text-destructive">
      {message}
    </p>
  );
}

export function CreateApiKeyDialog({
  accounts,
  nameMax,
  atLimit,
  apiBase,
  size = 'default',
  listHeadingId,
}: CreateApiKeyDialogProps) {
  const id = useId();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<CreateKeyForm>(emptyCreateForm);
  const [errors, setErrors] = useState<CreateKeyErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [created, setCreated] = useState<{ key: string; name: string } | null>(null);
  const [filter, setFilter] = useState('');
  const focusReturn = useFocusReturn();

  const shownAccounts = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q === '' ? accounts : accounts.filter((a) => a.name.toLowerCase().includes(q));
  }, [accounts, filter]);

  function update(patch: Partial<CreateKeyForm>): void {
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

  function toggleAccount(publicId: string, on: boolean): void {
    setForm((f) => ({
      ...f,
      accountPublicIds: on
        ? [...new Set([...f.accountPublicIds, publicId])]
        : f.accountPublicIds.filter((p) => p !== publicId),
    }));
  }

  function reset(): void {
    setForm(emptyCreateForm());
    setErrors({});
    setFormError(null);
    setCreated(null);
    setFilter('');
  }

  function onOpenChange(next: boolean): void {
    if (pending) return;
    if (!next && created) {
      // Resolved when the dialog has closed: the list's heading may only exist after the refresh.
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
    const invalid = validateCreateForm(form, nameMax);
    setErrors(invalid);
    setFormError(null);
    if (Object.keys(invalid).length > 0) return;
    setPending(true);
    try {
      const res = await fetch('/api/app/api-keys', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(createKeyBody(form)),
      });
      const body: unknown = await res.json().catch(() => null);
      const key = res.status === 201 ? createdKeyFrom(body) : null;
      if (key) {
        setCreated({ key, name: form.name.trim() });
        toast.success('API key created');
        return;
      }
      const details =
        res.status === 400 && typeof body === 'object' && body !== null
          ? (body as { error?: { details?: unknown } }).error?.details
          : undefined;
      const fieldErrors = createKeyFieldErrors(details);
      setErrors(fieldErrors);
      if (Object.keys(fieldErrors).length === 0) {
        setFormError(createFailureMessage(res.status, body));
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
        <Button type="button" size={size} disabled={atLimit}>
          <PlusIcon aria-hidden data-icon="inline-start" />
          Create key
        </Button>
      </DialogTrigger>
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg"
        showCloseButton={!pending}
        onCloseAutoFocus={focusReturn.onCloseAutoFocus}
        // Once the key is shown, only "Done" (or the close button) leaves: no accidental dismissal.
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
                Copy your new key
              </DialogTitle>
              <DialogDescription>
                {created.name}: paste it into the app that will use it.
              </DialogDescription>
            </DialogHeader>
            <Alert className="border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-200">
              <TriangleAlertIcon aria-hidden />
              <AlertTitle>You won&apos;t see this key again</AlertTitle>
              <AlertDescription className="text-current">
                The hub stores only a fingerprint of it. Copy it now and keep it somewhere safe,
                like a password. If you lose it, revoke it and create a new one.
              </AlertDescription>
            </Alert>
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${id}-key`}>API key</Label>
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
                <CopyButton value={created.key} what="API key" />
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
              <DialogTitle>Create an API key</DialogTitle>
              <DialogDescription>
                A key reads only what you choose here, and never more than you can see yourself.
              </DialogDescription>
            </DialogHeader>

            <div className="flex flex-col gap-2">
              <Label htmlFor={`${id}-name`}>Name</Label>
              <Input
                id={`${id}-name`}
                value={form.name}
                onChange={(e) => update({ name: e.target.value })}
                placeholder="Home Assistant"
                autoComplete="off"
                aria-invalid={errors.name ? true : undefined}
                aria-describedby={errors.name ? `${id}-name-error` : `${id}-name-hint`}
              />
              {errors.name ? (
                <FieldError id={`${id}-name-error`} message={errors.name} />
              ) : (
                <p id={`${id}-name-hint`} className="text-xs text-muted-foreground">
                  So you can recognise it later. At most {nameMax} characters.
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

            <fieldset
              className="flex flex-col gap-2"
              aria-describedby={errors.accountPublicIds ? `${id}-acc-error` : undefined}
            >
              <legend className="mb-1 text-sm font-medium">Which accounts</legend>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  name={`${id}-scope`}
                  value="all_visible"
                  checked={form.scope === 'all_visible'}
                  onChange={() => update({ scope: 'all_visible' })}
                  className="mt-0.5 size-4 accent-primary"
                />
                <span>
                  Every account I can see, now and later
                  <span className="block text-xs text-muted-foreground">
                    New accounts and newly shared ones are included automatically.
                  </span>
                </span>
              </label>
              <label
                className={cn(
                  'flex items-start gap-2 text-sm',
                  accounts.length === 0 && 'opacity-60',
                )}
              >
                <input
                  type="radio"
                  name={`${id}-scope`}
                  value="list"
                  checked={form.scope === 'list'}
                  disabled={accounts.length === 0}
                  onChange={() => update({ scope: 'list' })}
                  className="mt-0.5 size-4 accent-primary"
                />
                <span>
                  Only the accounts I pick
                  {accounts.length === 0 && (
                    <span className="block text-xs text-muted-foreground">
                      You can&apos;t see any accounts yet.
                    </span>
                  )}
                </span>
              </label>
              {form.scope === 'list' && accounts.length > 0 && (
                <div className="flex flex-col gap-2 pl-6">
                  {accounts.length >= FILTER_FROM && (
                    <Input
                      type="search"
                      value={filter}
                      onChange={(e) => setFilter(e.target.value)}
                      placeholder="Filter accounts"
                      aria-label="Filter accounts"
                      className="h-8"
                    />
                  )}
                  <div
                    role="group"
                    aria-label="Accounts"
                    className="flex max-h-48 flex-col gap-2 overflow-y-auto rounded-lg border p-2"
                  >
                    {shownAccounts.length === 0 ? (
                      <p className="text-sm text-muted-foreground">No account matches.</p>
                    ) : (
                      shownAccounts.map((account) => {
                        const boxId = `${id}-acc-${account.publicId}`;
                        return (
                          <div key={account.publicId} className="flex items-center gap-2">
                            <Checkbox
                              id={boxId}
                              checked={form.accountPublicIds.includes(account.publicId)}
                              onCheckedChange={(checked) =>
                                toggleAccount(account.publicId, checked === true)
                              }
                              aria-invalid={errors.accountPublicIds ? true : undefined}
                            />
                            <Label htmlFor={boxId} className="font-normal">
                              {account.name}
                            </Label>
                          </div>
                        );
                      })
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {form.accountPublicIds.length} selected
                  </p>
                </div>
              )}
              <FieldError id={`${id}-acc-error`} message={errors.accountPublicIds} />
            </fieldset>

            <div className="flex flex-col gap-2">
              <Label htmlFor={`${id}-expiry`}>Expires</Label>
              <select
                id={`${id}-expiry`}
                value={form.expiry}
                onChange={(e) => update({ expiry: e.target.value })}
                aria-invalid={errors.expiresInDays ? true : undefined}
                className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive sm:max-w-48 dark:bg-input/30 [&_option]:bg-popover"
              >
                {EXPIRY_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              <FieldError id={`${id}-expiry-error`} message={errors.expiresInDays} />
            </div>

            <p className="text-xs text-muted-foreground">
              Access is checked on every request against the owners&apos; sharing settings: when
              someone stops sharing with you, the key stops seeing it too.
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

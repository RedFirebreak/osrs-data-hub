'use client';
/**
 * The pieces a "create key" dialog is composed of (user keys, D-76; service keys, D-88): the dialog
 * frame, the "copy your key" view, and the fields both kinds have (a text field, the categories, the
 * expiry) with the form's footer. Each dialog lists its own fields and brings its own texts, so the
 * two kinds can differ (account scope for a user key, a rate limit for a service key); the state is
 * useCreateKeyDialog's.
 *
 * Every part takes the id of its control and derives the ids of its error and hint from it.
 */
import { CATEGORIES, CATEGORY_LABELS, type Category } from '@hub/core';
import { KeyRoundIcon, LoaderCircleIcon, TriangleAlertIcon } from 'lucide-react';
import { CopyButton } from '@/components/common/copy-button';
import { FieldError } from '@/components/common/field-error';
import { NativeSelect } from '@/components/common/native-select';
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
import { EXPIRY_OPTIONS } from './api-key-model';
import type { CreateKeyDialog, CreatedKey } from './use-create-key-dialog';

/**
 * The dialog around the form or the created key. It can't be closed while the request runs, and once
 * the key is shown only "Done" (or the close button) leaves it: no accidental dismissal.
 */
export function KeyDialog({
  dialog,
  trigger,
  children,
}: {
  dialog: Pick<
    CreateKeyDialog<unknown, string>,
    'open' | 'onOpenChange' | 'pending' | 'created' | 'onCloseAutoFocus'
  >;
  /** The button that opens the dialog. */
  trigger: React.ReactNode;
  children: React.ReactNode;
}) {
  const locked = dialog.created !== null || dialog.pending;
  return (
    <Dialog open={dialog.open} onOpenChange={dialog.onOpenChange}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg"
        showCloseButton={!dialog.pending}
        onCloseAutoFocus={dialog.onCloseAutoFocus}
        onInteractOutside={(e) => {
          if (locked) e.preventDefault();
        }}
        onEscapeKeyDown={(e) => {
          if (locked) e.preventDefault();
        }}
      >
        {children}
      </DialogContent>
    </Dialog>
  );
}

/** The key, shown once: read-only with a Copy button, a warning and a line to try it with. */
export function CreatedKeyView({
  id,
  created,
  title,
  description,
  warning,
  label,
  copyWhat,
  apiBase,
  onDone,
}: {
  id: string;
  created: CreatedKey;
  title: string;
  description: string;
  /** What to do with the key now, under "You won't see this key again". */
  warning: string;
  /** The key field's label. */
  label: string;
  /** What the Copy button copies, for its accessible name ("Copy API key"). */
  copyWhat: string;
  /** Absolute base URL of the API (APP_URL + /api/v1), for the "try it" line. */
  apiBase: string;
  onDone: () => void;
}) {
  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <KeyRoundIcon aria-hidden className="size-4" />
          {title}
        </DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      <Alert className="border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-200">
        <TriangleAlertIcon aria-hidden />
        <AlertTitle>You won&apos;t see this key again</AlertTitle>
        <AlertDescription className="text-current">{warning}</AlertDescription>
      </Alert>
      <div className="flex flex-col gap-2">
        <Label htmlFor={id}>{label}</Label>
        <div className="flex items-center gap-2">
          <Input
            id={id}
            readOnly
            value={created.key}
            onFocus={(e) => e.currentTarget.select()}
            className="font-mono text-xs"
            spellCheck={false}
            autoComplete="off"
          />
          <CopyButton value={created.key} what={copyWhat} />
        </div>
        <p className="text-xs text-muted-foreground">
          Try it:{' '}
          <code className="break-all">
            curl -H &quot;Authorization: Bearer &lt;key&gt;&quot; {apiBase}/me
          </code>
        </p>
      </div>
      <DialogFooter>
        <Button type="button" onClick={onDone}>
          Done
        </Button>
      </DialogFooter>
    </>
  );
}

/** A labelled text input with its hint, which the field's error replaces (the name, a rate limit). */
export function KeyTextField({
  id,
  label,
  value,
  onChange,
  error,
  hint,
  placeholder,
  inputMode,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  error: string | undefined;
  hint: React.ReactNode;
  placeholder?: string;
  inputMode?: 'numeric';
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        inputMode={inputMode}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete="off"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : `${id}-hint`}
      />
      {error ? (
        <FieldError id={`${id}-error`} message={error} />
      ) : (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  );
}

/** "What it can read": one checkbox per sharing category, nothing preselected (D-76). */
export function KeyCategoriesField({
  id,
  value,
  onChange,
  error,
}: {
  id: string;
  value: readonly Category[];
  onChange: (categories: Category[]) => void;
  error: string | undefined;
}) {
  return (
    <fieldset className="flex flex-col gap-3" aria-describedby={error ? `${id}-error` : undefined}>
      <legend className="mb-1 text-sm font-medium">What it can read</legend>
      <div className="grid gap-3 sm:grid-cols-2">
        {CATEGORIES.map((category) => {
          const boxId = `${id}-${category}`;
          return (
            <div key={category} className="flex items-start gap-2">
              <Checkbox
                id={boxId}
                checked={value.includes(category)}
                onCheckedChange={(checked) =>
                  onChange(
                    checked === true
                      ? [...new Set([...value, category])]
                      : value.filter((c) => c !== category),
                  )
                }
                aria-invalid={error ? true : undefined}
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
      <FieldError id={`${id}-error`} message={error} />
    </fieldset>
  );
}

/** "Expires": one of EXPIRY_OPTIONS. */
export function KeyExpiryField({
  id,
  value,
  onChange,
  error,
  className,
}: {
  id: string;
  value: string;
  onChange: (expiry: string) => void;
  error: string | undefined;
  /** For the select, e.g. a maximum width. */
  className?: string;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>Expires</Label>
      <NativeSelect
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        className={className}
      >
        {EXPIRY_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </NativeSelect>
      <FieldError id={`${id}-error`} message={error} />
    </div>
  );
}

/** The form's own error line (what belongs to no field) and its Cancel and submit buttons. */
export function KeyFormFooter({
  error,
  pending,
  submitLabel,
  onCancel,
}: {
  error: string | null;
  pending: boolean;
  submitLabel: string;
  onCancel: () => void;
}) {
  return (
    <>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" disabled={pending} onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending}>
          {pending && <LoaderCircleIcon aria-hidden className="animate-spin" />}
          {submitLabel}
        </Button>
      </DialogFooter>
    </>
  );
}

'use client';
/**
 * The "Minimum loot value" field, used by the Settings form (live toasts) and by Admin → Settings
 * (the guild feed, D-81): a text input that takes whole gp or the in-game shorthand
 * (parseMinLootValue: "100k", "1.5m"), quick-value buttons, and a help line that says what the typed
 * value does. Each form brings its own quick values and wording.
 */
import { formatGp } from '@hub/core';
import { Button } from '@/components/ui/button';
import { FieldError } from '@/components/ui/field-error';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { parseMinLootValue } from './settings-model';

export interface MinLootFieldProps {
  /** The input's id; the help line and the error are `<id>-help` and `<id>-error`. */
  id: string;
  /** The value as typed. */
  value: string;
  onChange: (value: string) => void;
  /** Highest value the server accepts. */
  max: number;
  /** The quick values in gp; 0 is shown as "Any". */
  presets: readonly number[];
  /** What the value does: for 0, and for an amount (formatGp, without "gp"). */
  help: { any: string; below: (amount: string) => string };
  /** The field's error from saving, shown under the help line. */
  error?: string;
  /** Mark a value that can't be read as invalid while it is typed; without it only `error` does. */
  flagUnreadable?: boolean;
  disabled?: boolean;
}

export function MinLootField({
  id,
  value,
  onChange,
  max,
  presets,
  help,
  error,
  flagUnreadable = false,
  disabled,
}: MinLootFieldProps) {
  const min = parseMinLootValue(value, max);
  const unreadable = flagUnreadable && min === null;
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>Minimum loot value</Label>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Input
          id={id}
          inputMode="numeric"
          autoComplete="off"
          className="sm:max-w-44"
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={error || unreadable ? true : undefined}
          aria-describedby={`${id}-help${error ? ` ${id}-error` : ''}`}
        />
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Quick values">
          {presets.map((preset) => (
            <Button
              key={preset}
              type="button"
              size="xs"
              variant={min === preset ? 'secondary' : 'outline'}
              disabled={disabled}
              onClick={() => onChange(String(preset))}
            >
              {preset === 0 ? 'Any' : formatGp(preset)}
            </Button>
          ))}
        </div>
      </div>
      <p
        id={`${id}-help`}
        className={unreadable ? 'text-sm text-destructive' : 'text-sm text-muted-foreground'}
      >
        {min === null
          ? 'Whole gp, or shorthand like 100k or 1.5m (decimals with a point).'
          : min === 0
            ? help.any
            : help.below(formatGp(min))}
      </p>
      <FieldError id={`${id}-error`} message={error} />
    </div>
  );
}

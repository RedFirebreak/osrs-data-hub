/**
 * Wizard step 1 (handoff §6.3): install or update HA Exporter from the RuneLite Plugin Hub, and an
 * optional device label that becomes the device's name on the Devices page. Submitting the form
 * (the button or Enter in the label field) moves on to pairing.
 */
import { ArrowRightIcon, PuzzleIcon, SearchIcon } from 'lucide-react';
import { useId } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { StepHeading } from './step-heading';
import { DEVICE_LABEL_MAX_LENGTH } from './wizard-model';

export interface InstallStepProps {
  /** MIN_PLUGIN_VERSION, e.g. "1.5". */
  minPluginVersion: string;
  label: string;
  onLabelChange(label: string): void;
  onNext(): void;
  headingRef?: React.Ref<HTMLHeadingElement>;
}

export function InstallStep({
  minPluginVersion,
  label,
  onLabelChange,
  onNext,
  headingRef,
}: InstallStepProps) {
  const id = useId();
  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(e) => {
        e.preventDefault();
        onNext();
      }}
    >
      <StepHeading
        step={1}
        headingRef={headingRef}
        title="Install HA Exporter"
        description={`Install HA Exporter (${minPluginVersion} or newer) from the RuneLite Plugin Hub.`}
      />

      <div className="grid gap-6 md:grid-cols-[1fr_minmax(0,16rem)] md:items-start">
        <ol className="flex flex-col gap-3 text-sm">
          {[
            <>
              In RuneLite, open <strong>Configuration</strong> (the wrench icon in the sidebar) and
              click <strong>Plugin Hub</strong>.
            </>,
            <>
              Search for <strong>HA Exporter</strong>.
            </>,
            <>
              Click <strong>Install</strong>. The plugin&apos;s icon appears in the RuneLite
              sidebar.
            </>,
            <>
              Already installed? <strong>Restart RuneLite</strong>: that updates Plugin Hub plugins
              to their newest version.
            </>,
          ].map((text, i) => (
            <li key={i} className="flex gap-3">
              <span
                aria-hidden
                className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium tabular-nums"
              >
                {i + 1}
              </span>
              <span className="pt-0.5 text-pretty">{text}</span>
            </li>
          ))}
        </ol>
        <PluginHubIllustration />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor={`${id}-label`}>Name this device (optional)</Label>
        <Input
          id={`${id}-label`}
          value={label}
          onChange={(e) => onLabelChange(e.target.value)}
          placeholder="e.g. Desktop PC"
          maxLength={DEVICE_LABEL_MAX_LENGTH}
          autoComplete="off"
          aria-describedby={`${id}-label-help`}
          className="sm:max-w-80"
        />
        <p id={`${id}-label-help`} className="text-sm text-muted-foreground">
          Helps you tell your computers apart on the Devices page. You can change it later.
        </p>
      </div>

      <div className="flex justify-end">
        <Button type="submit" size="lg">
          Next: get a pairing code
          <ArrowRightIcon aria-hidden data-icon="inline-end" />
        </Button>
      </div>
    </form>
  );
}

/**
 * A drawn stand-in for a Plugin Hub screenshot (no external images): the search box and the
 * HA Exporter entry with its Install button. Decorative; the steps say the same in words.
 */
function PluginHubIllustration() {
  return (
    <figure className="flex flex-col gap-2">
      <div
        aria-hidden
        className="flex flex-col gap-2 rounded-lg border border-dashed bg-muted/40 p-3 text-xs select-none"
      >
        <div className="flex items-center gap-2 rounded-md border bg-background px-2 py-1.5 text-muted-foreground">
          <SearchIcon className="size-3.5" />
          <span className="text-foreground">HA Exporter</span>
        </div>
        <div className="flex items-center gap-2 rounded-md bg-background p-2 ring-1 ring-foreground/10">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
            <PuzzleIcon className="size-4" />
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate font-medium">HA Exporter</span>
            <span className="truncate text-muted-foreground">Sends your game data</span>
          </span>
          <span className="rounded-md bg-primary px-2 py-1 font-medium text-primary-foreground">
            Install
          </span>
        </div>
      </div>
      <figcaption className="text-xs text-muted-foreground">
        RuneLite → Configuration → Plugin Hub
      </figcaption>
    </figure>
  );
}

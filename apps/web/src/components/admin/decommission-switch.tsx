'use client';
/**
 * The decommission switch (handoff §3.2, §12, D-19): turning it on needs the hub name typed into a
 * confirmation dialog (the route checks the same text); turning it off needs a plain confirmation.
 * PUT /api/app/admin/decommission, then the page refreshes to show the new state.
 */
import { LoaderCircleIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { DECOMMISSION_API_PATH, decommissionConfirmMatches } from './admin-model';
import { useAdminRequest } from './use-admin-request';

export interface DecommissionSwitchProps {
  decommissioned: boolean;
  hubName: string;
}

export function DecommissionSwitch({ decommissioned, hubName }: DecommissionSwitchProps) {
  const router = useRouter();
  const switchId = useId();
  const inputId = useId();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const { pending, error, setError, send } = useAdminRequest();
  const turningOn = !decommissioned;
  const confirmed = !turningOn || decommissionConfirmMatches(typed, hubName);

  async function submit(): Promise<void> {
    if (!confirmed) return;
    const body = await send(
      DECOMMISSION_API_PATH,
      {
        method: 'PUT',
        json: turningOn
          ? { decommissioned: true, confirm: typed.trim() }
          : { decommissioned: false },
      },
      "Couldn't change the switch. Try again in a moment.",
    );
    if (body === null) return;
    setOpen(false);
    setTyped('');
    toast.success(turningOn ? 'The hub is decommissioned' : 'Decommissioning turned off', {
      description: turningOn
        ? 'Every plugin disables its connection at its next send.'
        : 'Plugins can pair with the hub again.',
    });
    router.refresh();
  }

  return (
    <>
      <div className="flex items-center gap-3">
        <Switch
          id={switchId}
          checked={decommissioned}
          onCheckedChange={() => {
            setError(null);
            setTyped('');
            setOpen(true);
          }}
          className="data-checked:bg-destructive"
        />
        <Label htmlFor={switchId} className="text-sm font-medium">
          Decommission this hub
        </Label>
      </div>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (pending) return;
          setOpen(next);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <DialogHeader>
              <DialogTitle>
                {turningOn ? `Decommission ${hubName}?` : 'Turn decommissioning off?'}
              </DialogTitle>
              <DialogDescription asChild>
                <div className="flex flex-col gap-2">
                  {turningOn ? (
                    <>
                      <p>
                        From now on the hub answers every plugin with 410 Gone. Each HA Exporter
                        plugin that receives it disables its connection permanently, and pairing is
                        refused.
                      </p>
                      <p>
                        Turning the switch off later doesn&apos;t bring those connections back:
                        every player would have to turn theirs on again in the plugin.
                      </p>
                    </>
                  ) : (
                    <p>
                      The hub accepts data and pairings again. Plugins that already received 410
                      have disabled their connection: those players have to turn it on again in the
                      plugin&apos;s settings.
                    </p>
                  )}
                </div>
              </DialogDescription>
            </DialogHeader>
            {turningOn && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={inputId}>
                  Type <strong className="font-mono">{hubName.trim()}</strong> to confirm
                </Label>
                <Input
                  id={inputId}
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  disabled={pending}
                />
              </div>
            )}
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={() => setOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant={turningOn ? 'destructive' : 'default'}
                disabled={pending || !confirmed}
              >
                {pending && <LoaderCircleIcon aria-hidden className="animate-spin" />}
                {turningOn ? 'Decommission hub' : 'Turn off'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

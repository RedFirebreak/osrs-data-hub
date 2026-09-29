/**
 * Settings → "Download my data" (D-79): what the file holds and a plain download link to
 * GET /api/app/export. A plain link on purpose: the browser streams the attachment to disk, where a
 * fetch would hold the whole file in memory, and a same-origin link sends `Sec-Fetch-Site:
 * same-origin`, which the route requires.
 */
import { DownloadIcon } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

const EXPORT_PATH = '/api/app/export';

export function ExportDataCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Download my data</h2>
        </CardTitle>
        <CardDescription>
          A copy of what the hub keeps about you and your accounts, as one JSON file.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 text-sm">
        <ul className="ml-5 list-disc space-y-1.5">
          <li>
            Your profile, settings, devices, API keys (never their secrets), sign-ins, the sharing
            settings you made and the audit log entries about you.
          </li>
          <li>
            Every account you own or play on: its current state, XP history, events, play sessions,
            gear changes, wealth per day and location trail, limited to what you can see in the hub.
          </li>
          <li>
            Not included: the raw plugin messages kept for a few days for troubleshooting, and other
            players&apos; data beyond the names the hub shows you.
          </li>
        </ul>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
          {/* A plain link, not <Link>: an API route that answers with a file. */}
          <a
            href={EXPORT_PATH}
            download
            className={cn(buttonVariants({ variant: 'outline' }), 'w-fit')}
          >
            <DownloadIcon aria-hidden data-icon="inline-start" />
            Download my data
          </a>
          <p className="text-muted-foreground">
            Once every 10 minutes. A long history can take a moment.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * "Connect an AI assistant" (D-137) on the API keys page: the hub's MCP URL to copy, the Claude.ai
 * steps (it signs in itself, so it needs no key), and the website's page for the clients that take
 * a pasted key (Claude Code, Cursor, Claude Desktop). Without it a member only finds the URL if
 * someone tells them.
 */
import { ExternalLinkIcon, SparklesIcon } from 'lucide-react';
import { CopyButton } from '@/components/common/copy-button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export function AssistantCard({ mcpUrl, docsUrl }: { mcpUrl: string; docsUrl: string }) {
  return (
    <Card aria-labelledby="assistant-card-title">
      <CardHeader>
        <CardTitle id="assistant-card-title" className="flex items-center gap-2">
          <SparklesIcon aria-hidden className="size-4 text-muted-foreground" />
          Connect an AI assistant
        </CardTitle>
        <CardDescription>
          Ask Claude what you did this weekend, who has a pet, or how the guild did this week. It
          reads the hub like a key does: only what you can see yourself.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm text-pretty">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <code
            data-testid="mcp-url"
            className="min-h-9 flex-1 rounded-lg border bg-background px-3 py-2 font-mono text-sm break-all"
          >
            {mcpUrl}
          </code>
          <CopyButton value={mcpUrl} what="MCP URL" />
        </div>
        <p>
          <strong>Claude.ai</strong>: Settings → Connectors → Add custom connector, paste this URL,
          then sign in here and allow it. That creates a key for it, listed below as a connected
          assistant; revoke it to disconnect.
        </p>
        <p className="text-muted-foreground">
          For Claude Code, Cursor or Claude Desktop, create a key with &ldquo;For an AI
          assistant&rdquo; and follow the{' '}
          <a
            href={docsUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 font-medium text-foreground underline underline-offset-4"
          >
            setup guide
            <ExternalLinkIcon aria-hidden className="size-3" />
          </a>
          .
        </p>
      </CardContent>
    </Card>
  );
}

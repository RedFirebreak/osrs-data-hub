/**
 * An outline badge whose meaning needs a sentence ("Not shared", "Special world"): the explanation is
 * in a tooltip (the badge is keyboard-focusable) and in screen-reader text after the label. Server-
 * and client-safe (the tooltip parts are client components); needs a TooltipProvider above it.
 *
 *   <ExplainedBadge explanation="From a special world…" className="text-violet-700">
 *     Special world
 *   </ExplainedBadge>
 */
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

export interface ExplainedBadgeProps {
  /** The sentence behind the badge (tooltip and screen-reader text). */
  explanation: string;
  /** The badge's label, with an icon before it if it has one. */
  children: React.ReactNode;
  className?: string;
}

export function ExplainedBadge({ explanation, children, className }: ExplainedBadgeProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="outline" tabIndex={0} className={cn('cursor-help', className)}>
          {children}
          <span className="sr-only">: {explanation}</span>
        </Badge>
      </TooltipTrigger>
      <TooltipContent>{explanation}</TooltipContent>
    </Tooltip>
  );
}

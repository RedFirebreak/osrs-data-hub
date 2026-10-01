'use client';
/**
 * The "who can see what" list of an account (handoff §10): per category an audience (Private /
 * Guild / Selected people), the default marked, and for "Selected people" the members granted it
 * with an "Add person" picker. Shared by the account page's sharing panel and the wizard's last
 * step; the state and the requests are the caller's (useSharing).
 */
import type { Audience, Category } from '@hub/core';
import { XIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { GrantPicker } from './grant-picker';
import { AUDIENCE_OPTIONS, audienceLabel } from './sharing-model';
import type { Sharing } from './use-sharing';

export interface CategoryAudiencesProps {
  /** Prefix of the controls' ids: `<idPrefix>-<category>` for a select, `…-add` for its picker. */
  idPrefix: string;
  sharing: Sharing;
  /** CATEGORY_LABELS from @hub/core. */
  categoryLabels: Readonly<Record<Category, { label: string; covers: string }>>;
  /** DEFAULT_AUDIENCE from @hub/core. */
  defaults: Readonly<Record<Category, Audience>>;
}

export function CategoryAudiences({
  idPrefix,
  sharing,
  categoryLabels,
  defaults,
}: CategoryAudiencesProps) {
  const { settings, pending, members, loadMembers, apply } = sharing;
  const canManage = settings.canManage;
  return (
    <ul className="flex flex-col divide-y">
      {settings.categories.map((c) => {
        const { label, covers } = categoryLabels[c.category];
        const selectId = `${idPrefix}-${c.category}`;
        return (
          <li key={c.category} className="flex flex-col gap-2 py-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <label htmlFor={selectId} className="text-sm font-medium">
                  {label}
                </label>
                <p className="text-xs text-muted-foreground">{covers}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {c.isDefault && (
                  <Badge variant="secondary" title="No choice made yet: the hub's default">
                    Default
                  </Badge>
                )}
                <Select
                  value={c.audience}
                  disabled={!canManage || pending}
                  onValueChange={(value) =>
                    void apply(
                      {
                        action: 'audience',
                        category: c.category,
                        audience: value as Audience,
                      },
                      { category: label },
                      selectId,
                    )
                  }
                >
                  <SelectTrigger id={selectId} size="sm" className="w-44">
                    <SelectValue>{audienceLabel(c.audience)}</SelectValue>
                  </SelectTrigger>
                  <SelectContent position="popper" align="end">
                    {AUDIENCE_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        <span className="flex flex-col">
                          <span>
                            {o.label}
                            {defaults[c.category] === o.value && (
                              <span className="text-muted-foreground"> (default)</span>
                            )}
                          </span>
                          <span className="text-xs text-muted-foreground">{o.hint}</span>
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            {c.audience === 'selected' && (
              <div className="flex flex-wrap items-center gap-1.5">
                {c.grants.length === 0 && (
                  <span className="text-xs text-muted-foreground">
                    Nobody added yet: only the players see it.
                  </span>
                )}
                {c.grants.map((g) => (
                  <Badge key={g.userId} variant="outline" className="h-6 gap-1 pr-1">
                    {g.name}
                    {canManage && (
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() =>
                          void apply(
                            { action: 'revoke', category: c.category, userId: g.userId },
                            { category: label, user: g.name },
                            // This badge goes away: "Add person" of the same category.
                            `${selectId}-add`,
                          )
                        }
                        className="rounded-full p-0.5 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
                        aria-label={`Remove ${g.name} from ${label}`}
                      >
                        <XIcon aria-hidden className="size-3" />
                      </button>
                    )}
                  </Badge>
                ))}
                {canManage && (
                  <GrantPicker
                    triggerId={`${selectId}-add`}
                    category={c.category}
                    categoryLabel={label}
                    settings={settings}
                    members={members}
                    loadMembers={loadMembers}
                    disabled={pending}
                    onGrant={(m) =>
                      void apply(
                        { action: 'grant', category: c.category, userId: m.userId },
                        { category: label, user: m.name },
                        `${selectId}-add`,
                      )
                    }
                  />
                )}
              </div>
            )}
            {c.audience !== 'selected' && c.grants.length > 0 && (
              <p className="text-xs text-muted-foreground">
                {c.grants.length === 1 ? '1 person is' : `${c.grants.length} people are`} added;
                that applies while this is set to Selected people.
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}

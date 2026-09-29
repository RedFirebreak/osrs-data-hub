/**
 * Pure helpers behind the sharing panel: labels for audiences, who can still be granted a category,
 * the PATCH body for each change and the message shown after it. Client-safe: type-only imports
 * (the category labels and defaults come from the server as props, NEXT-12), unit-tested.
 */
import type { Audience, Category } from '@hub/core';
import type { ActiveMember, SharingContributor, SharingSettings } from '@hub/server';
import type { SharingChange } from '@/app/api/app/accounts/sharing-change';

export const AUDIENCE_OPTIONS: readonly { value: Audience; label: string; hint: string }[] = [
  { value: 'private', label: 'Private', hint: 'Only the owner and the players of this account' },
  { value: 'guild', label: 'Guild', hint: 'Every active member of the guild' },
  { value: 'selected', label: 'Selected people', hint: 'Only the members you add' },
];

export function audienceLabel(audience: Audience): string {
  return AUDIENCE_OPTIONS.find((o) => o.value === audience)?.label ?? audience;
}

/**
 * Members who can still be granted `category`: active members without a grant for it, leaving out the
 * account's owner and non-blocked contributors (they see everything anyway). Blocked contributors
 * can be granted (a block only takes away the contributor view). Filtered by `query` (case- and
 * accent-insensitive, on the name), in the members' order.
 */
export function grantCandidates(
  members: readonly ActiveMember[],
  settings: Pick<SharingSettings, 'categories' | 'contributors'>,
  category: Category,
  query = '',
): ActiveMember[] {
  const granted = new Set(
    settings.categories.find((c) => c.category === category)?.grants.map((g) => g.userId) ?? [],
  );
  const players = new Set(
    settings.contributors.filter((c) => c.role === 'owner' || !c.blocked).map((c) => c.userId),
  );
  const q = fold(query.trim());
  return members.filter(
    (m) =>
      !granted.has(m.userId) && !players.has(m.userId) && (q === '' || fold(m.name).includes(q)),
  );
}

function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

/** Contributors the ownership can be handed to: non-blocked, not the current owner. */
export function transferCandidates(
  contributors: readonly SharingContributor[],
): SharingContributor[] {
  return contributors.filter((c) => c.role !== 'owner' && !c.blocked);
}

/** The toast after a change went through. */
export function successMessage(
  change: SharingChange,
  names: { category?: string; user?: string } = {},
): string {
  const who = names.user ?? 'They';
  switch (change.action) {
    case 'audience':
      return `${names.category ?? 'Category'} is now ${audienceLabel(change.audience).toLowerCase()}`;
    case 'grant':
      return `${who} can now see ${names.category?.toLowerCase() ?? 'this'}`;
    case 'revoke':
      return `${who} can no longer see ${names.category?.toLowerCase() ?? 'this'}`;
    case 'transfer':
      return `${names.user ?? 'The new owner'} now owns this account`;
    case 'claim':
      return 'You now own this account';
    case 'block':
      return `${who} is blocked: nothing from their devices is stored for this account`;
    case 'unblock':
      return `${who} is unblocked`;
    case 'remove':
      return `${who} was removed from this account`;
  }
}

/**
 * A server message for a toast: the hub's error messages are lower-case fragments ("the owner can't
 * be blocked"); this makes them a sentence. Falls back to `fallback`.
 */
export function errorMessage(message: unknown, fallback: string): string {
  if (typeof message !== 'string' || message.trim() === '') return fallback;
  const text = message.trim();
  const sentence = text.charAt(0).toUpperCase() + text.slice(1);
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
}

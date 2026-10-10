/**
 * The character page of an account the viewer may see: the character as it is now
 * (components/account-page/character-view.tsx, shared with Home). notFound() when the account
 * doesn't exist or isn't visible to the viewer, so the two can't be told apart.
 *
 * The visibility check runs first, before anything streams, and the rest of the page loads inside a
 * <Suspense> with the page skeleton: a segment loading.tsx would start the response as 200 before
 * notFound(), leaving an unknown account a "soft 404" (NEXT-14).
 */
import { getConfig } from '@hub/core';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Suspense } from 'react';
import { AccountSkeleton } from '@/components/account-page/account-skeleton';
import { CharacterView } from '@/components/account-page/character-view';
import { loadVisible } from '@/lib/visible-account';

export async function generateMetadata({
  params,
}: PageProps<'/accounts/[publicId]'>): Promise<Metadata> {
  const { publicId } = await params;
  const visible = await loadVisible(publicId);
  return { title: `${visible?.account.name ?? 'Account'} · ${getConfig().hubName}` };
}

export default async function AccountPageRoute({ params }: PageProps<'/accounts/[publicId]'>) {
  const { publicId } = await params;
  // See NEXT-14: before any Suspense boundary, so the answer is a real 404.
  if (!(await loadVisible(publicId))) notFound();
  return (
    <Suspense fallback={<AccountSkeleton />}>
      <CharacterView publicId={publicId} />
    </Suspense>
  );
}

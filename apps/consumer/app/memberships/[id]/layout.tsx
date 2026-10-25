import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { fetchMembershipCard, listingMetadata, requestOrigin } from '@/lib/og/server';

/**
 * Link-preview tags for a shared membership plan (the page itself renders in the
 * browser). A membership plan the API won't show publicly (a draft, a preview) keeps
 * the site's generic tags.
 */
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const card = await fetchMembershipCard(id);
  return card ? listingMetadata(card, await requestOrigin()) : {};
}

export default function Layout({ children }: { children: ReactNode }) {
  return children;
}

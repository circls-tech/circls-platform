import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { fetchEventCard, listingMetadata, requestOrigin } from '@/lib/og/server';

/**
 * Link-preview tags for a shared event (the page itself renders in the
 * browser). A event the API won't show publicly (a draft, a preview) keeps
 * the site's generic tags.
 */
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const card = await fetchEventCard(id);
  return card ? listingMetadata(card, await requestOrigin()) : {};
}

export default function Layout({ children }: { children: ReactNode }) {
  return children;
}

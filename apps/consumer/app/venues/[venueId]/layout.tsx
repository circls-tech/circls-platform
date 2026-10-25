import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { fetchVenueCard, listingMetadata, requestOrigin } from '@/lib/og/server';

/**
 * Link-preview tags for a shared venue (the page itself renders in the
 * browser). A venue the API won't show publicly (a draft, a preview) keeps
 * the site's generic tags.
 */
export async function generateMetadata({ params }: { params: Promise<{ venueId: string }> }): Promise<Metadata> {
  const { venueId } = await params;
  const card = await fetchVenueCard(venueId);
  return card ? listingMetadata(card, await requestOrigin()) : {};
}

export default function Layout({ children }: { children: ReactNode }) {
  return children;
}

import { fetchVenueCard, requestOrigin } from '@/lib/og/server';
import { OG_SIZE, renderListingCard } from '@/lib/og/render';

export const size = OG_SIZE;
export const contentType = 'image/jpeg';
export const alt = 'A venue on circls';

/** The share image WhatsApp and the rest show under a link to this venue. */
export default async function Image({ params }: { params: Promise<{ venueId: string }> }) {
  const { venueId } = await params;
  return renderListingCard(await fetchVenueCard(venueId), await requestOrigin());
}

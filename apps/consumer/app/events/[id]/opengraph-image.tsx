import { fetchEventCard, requestOrigin } from '@/lib/og/server';
import { OG_SIZE, renderListingCard } from '@/lib/og/render';

export const size = OG_SIZE;
export const contentType = 'image/jpeg';
export const alt = 'An event on circls';

/** The share image WhatsApp and the rest show under a link to this event. */
export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return renderListingCard(await fetchEventCard(id), await requestOrigin());
}

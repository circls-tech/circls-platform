import type { Metadata } from 'next';
import { headers } from 'next/headers';
import type { PublicEventWithVenue, PublicMembershipWithScope, VenueDetail } from '@/lib/api/types';
import { eventCard, membershipCard, venueCard, type ListingCard } from './listing_card';

/**
 * Server-side reads for link previews. The browser's API client can't run
 * here (it signs requests with the visitor's Firebase session), and the
 * public listing endpoints need no session anyway.
 *
 * `API_INTERNAL_BASE_URL` is for a server that reaches the API at another
 * address than browsers do (the sandbox, where browsers use localhost:8080
 * but the consumer container must use http://api:8080). Unset, the server
 * uses the same base as the browser.
 */
const API_BASE =
  process.env.API_INTERNAL_BASE_URL || process.env.NEXT_PUBLIC_API_BASE_URL || 'https://api.circls.app';

async function fetchPublic<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${API_BASE}${path}`, { next: { revalidate: 300 } });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    // A preview is a nicety: an unreachable API leaves the generic one.
    return null;
  }
}

const id = (raw: string) => encodeURIComponent(raw);

export async function fetchEventCard(eventId: string): Promise<ListingCard | null> {
  const ev = await fetchPublic<PublicEventWithVenue>(`/v1/consumer/events/${id(eventId)}`);
  return ev ? eventCard(ev) : null;
}

export async function fetchVenueCard(venueId: string): Promise<ListingCard | null> {
  const v = await fetchPublic<VenueDetail>(`/v1/consumer/venues/${id(venueId)}`);
  return v ? venueCard(v) : null;
}

export async function fetchMembershipCard(membershipId: string): Promise<ListingCard | null> {
  const m = await fetchPublic<PublicMembershipWithScope>(`/v1/consumer/memberships/${id(membershipId)}`);
  return m ? membershipCard(m) : null;
}

/**
 * The origin this request came in on (circls.app, the stage site, a local
 * sandbox), so preview URLs point back at the same site. The proxy passes
 * `Host` through and says the scheme in `X-Forwarded-Proto`;
 * `X-Forwarded-Host` is not read, as any client can send one.
 */
export async function requestOrigin(): Promise<string> {
  const h = await headers();
  const host = h.get('host') ?? 'circls.app';
  const local = /^(localhost|127\.0\.0\.1)(:|$)/.test(host);
  const proto = h.get('x-forwarded-proto')?.split(',')[0]?.trim() || (local ? 'http' : 'https');
  return `${proto}://${host}`;
}

/**
 * A listing page's link-preview tags. The image itself comes from the page's
 * `opengraph-image` route, which Next adds to these on its own.
 */
export function listingMetadata(card: ListingCard, origin: string): Metadata {
  const title = `${card.title} · circls`;
  return {
    metadataBase: new URL(origin),
    title,
    description: card.description,
    alternates: { canonical: card.path },
    openGraph: {
      type: 'website',
      siteName: 'circls',
      title: card.title,
      description: card.description,
      url: card.path,
    },
    twitter: { card: 'summary_large_image', title: card.title, description: card.description },
  };
}

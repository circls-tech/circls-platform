import type { PublicEventWithVenue, PublicMembershipWithScope, VenueDetail } from '@/lib/api/types';
import { formatDayAtTime } from '../format';
import { cityOf } from '../location/geo';
import { matchSport, SPORT_IMAGES } from '../sportImages';

/**
 * What a shared link to a listing shows in WhatsApp, iMessage, Telegram and
 * the rest: the page's title and description tags, and the share image drawn
 * from the same fields (see ./render). One builder per listing type, from the
 * public listing the page itself shows.
 */
export interface ListingCard {
  /** The small label above the title. */
  kind: 'Event' | 'Venue' | 'Membership';
  title: string;
  /** One or two lines under the title: when and where, or where and what. */
  lines: string[];
  /** The link's description: the lines, joined. */
  description: string;
  /**
   * Pictures to try, best first: the listing's own photo (a URL), then the
   * sport photo its cards fall back to (a site path). None left that loads,
   * the image draws the brand mark instead.
   */
  pictures: string[];
  /** The listing's canonical path. */
  path: string;
}

function card(
  kind: ListingCard['kind'],
  title: string,
  lines: (string | null | undefined)[],
  pictures: (string | null | undefined)[],
  path: string,
): ListingCard {
  const kept = lines.filter((l): l is string => Boolean(l && l.trim()));
  const pics = pictures.filter((p): p is string => Boolean(p));
  return { kind, title, lines: kept, description: kept.join(' · '), pictures: pics, path };
}

/** The cover photo (position 0). */
function coverOf(images: { url: string; position: number }[] | undefined): string | null {
  return [...(images ?? [])].sort((a, b) => a.position - b.position)[0]?.url ?? null;
}

/** The sport photo the cards fall back to. */
function sportOf(tags: string[] | undefined): string | null {
  const sport = matchSport(tags);
  return sport ? SPORT_IMAGES[sport] : null;
}

/** When, in the event's own zone (where its guests read it), and where. */
export function eventCard(ev: PublicEventWithVenue): ListingCard {
  return card(
    'Event',
    ev.name,
    [ev.startsAt ? formatDayAtTime(ev.startsAt, ev.locTzName) : null, ev.venueName ?? ev.locationName],
    [coverOf(ev.images), sportOf(ev.venueTags)],
    `/events/${ev.id}`,
  );
}

/** Where, and the sports it is for (tags are stored as typed, often lower-case). */
export function venueCard({ venue }: VenueDetail): ListingCard {
  const city = venue.address?.city ?? cityOf(venue.addressJson);
  const sports = venue.tags.slice(0, 3).map((t) => t.charAt(0).toUpperCase() + t.slice(1));
  return card(
    'Venue',
    venue.name,
    [city, sports.join(' · ')],
    [coverOf(venue.images), sportOf(venue.tags)],
    `/venues/${venue.id}`,
  );
}

/** Where it is good (the venue, or the brand for a brand-wide plan), and for how long. */
export function membershipCard(m: PublicMembershipWithScope): ListingCard {
  const where = m.venueId ? m.scopeName : (m.brand?.name ?? m.scopeName);
  return card(
    'Membership',
    m.name,
    [where, m.durationDays > 0 ? `${m.durationDays}-day plan` : null],
    [m.artworkUrl, sportOf(m.venueTags)],
    `/memberships/${m.id}`,
  );
}

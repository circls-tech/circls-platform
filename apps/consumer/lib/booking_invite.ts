import type { MyBookingDetail, PublicEventWithVenue, PublicMembershipWithScope, WishlistItemType } from '@/lib/api/types';
import { formatDayAtTime } from './format';

/**
 * "Invite friends" on a booking, the way ticketing apps do it: a short note in
 * the booker's own voice (what they're going to, where and when) and a link to
 * the listing, so friends can see it and book their own place.
 *
 * Only public listing details go in: never the price, the reference, the QR
 * tickets or the booker's answers. The link is the listing's (the event, the
 * venue for a court, the plan), never the booking's, which only its owner can
 * open. Times are written in the zone the booking happens in, since that is
 * where the friends will read them.
 *
 * Checkout builds the invite from the listing (inviteForEvent, inviteForCourts,
 * inviteForMembership) and the booking page from the booking
 * (inviteForBooking); both go through the same rules below.
 */
export interface BookingInvite {
  /** The listing the link opens. */
  itemType: WishlistItemType;
  itemId: string;
  /** The share sheet's subject line (email and some chat apps use it). */
  title: string;
  /** The note itself, without the link. */
  message: string;
}

/** The slots of a court booking or cart, as far as an invite needs them. */
interface CourtSlot {
  arenaName: string;
  startAt: string;
  endAt: string;
}

/** A place is named only when there is a venue: without one, a booking's title is the listing's own name. */
const placeOf = (venueId: string | null, name: string | null) => (venueId ? name : null);
/** "Court 1", "Court 1 and Court 2", "Court 1, Court 2 and Court 3". */
const listOf = (names: string[]) =>
  names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

/**
 * WhatsApp bold. Most invites go out on WhatsApp, which shows `*name*` in
 * bold; other apps show the asterisks, which still reads. A `*` inside the
 * name would end the bold early, so it is dropped.
 */
const bold = (s: string) => `*${s.replace(/\*/g, '').trim()}*`;

/** A note, one line each: what, when, where, and the ask (the link follows on the next line). */
const note = (ask: string, ...ls: (string | null)[]) => [...ls.filter(Boolean), ask].join('\n');
const lines = (...ls: (string | null)[]) => note('Care to join me? 👇', ...ls);

/** The next slot still to come, and every court booked for its time. */
function nextCourtSlots(slots: CourtSlot[], now: Date): { startAt: string; courts: string[] } | null {
  const upcoming = slots.filter((s) => Date.parse(s.endAt) > now.getTime());
  if (upcoming.length === 0) return null;
  const first = Math.min(...upcoming.map((s) => Date.parse(s.startAt)));
  const firstSlots = upcoming.filter((s) => Date.parse(s.startAt) === first);
  return { startAt: firstSlots[0]!.startAt, courts: [...new Set(firstSlots.map((s) => s.arenaName))] };
}

function eventInvite(
  e: { id: string; name: string; startsAt: string },
  place: string | null,
  timeZone: string | undefined,
): BookingInvite {
  return {
    itemType: 'event',
    itemId: e.id,
    title: `Join me at ${e.name}`,
    message: lines(
      `Hi! I'm going to ${bold(e.name)}`,
      `📅 ${formatDayAtTime(e.startsAt, timeZone)}`,
      place ? `📍 ${place}` : null,
    ),
  };
}

function membershipInvite(m: { id: string; name: string }, place: string | null): BookingInvite {
  return {
    itemType: 'membership',
    itemId: m.id,
    title: `Join me at ${place ?? m.name}`,
    message: lines(`Hi! I've joined ${bold(m.name)}`, place ? `📍 ${place}` : null),
  };
}

/** Checkout's invite for an event about to be booked. */
export function inviteForEvent(
  ev: Pick<PublicEventWithVenue, 'id' | 'name' | 'startsAt' | 'venueId' | 'venueName' | 'locTzName'>,
): BookingInvite {
  return eventInvite(ev, placeOf(ev.venueId, ev.venueName), ev.locTzName);
}

/** Checkout's invite for a membership plan about to be bought. */
export function inviteForMembership(
  m: Pick<PublicMembershipWithScope, 'id' | 'name' | 'venueId' | 'scopeName'>,
): BookingInvite {
  return membershipInvite(m, placeOf(m.venueId, m.scopeName));
}

/**
 * A court booking (or cart) links to the venue: friends come to play, not to
 * book the same slot. It names the next slot still to come and every court
 * booked for that time ("Court 1 and Court 2"); null once every slot is over.
 */
export function inviteForCourts(
  venue: { id: string; name: string; timeZone?: string | undefined },
  slots: CourtSlot[],
  now: Date = new Date(),
): BookingInvite | null {
  const next = nextCourtSlots(slots, now);
  if (!next) return null;
  return {
    itemType: 'venue',
    itemId: venue.id,
    title: `Play with me at ${venue.name}`,
    message: lines(
      `Hi! I've booked ${listOf(next.courts)} at ${bold(venue.name)}`,
      `📅 ${formatDayAtTime(next.startAt, venue.timeZone)}`,
    ),
  };
}

/**
 * What "Share booking" sends with one ticket's link: a note telling the
 * friend the ticket is theirs (what, when, where) and to tap the link to add
 * it to their bookings. `ticketLabel` names a court ticket's court. Null for
 * a booking whose tickets can't be shared (not an event or court booking).
 */
export function ticketShareNote(
  b: MyBookingDetail,
  ticketLabel: string | null,
  now: Date = new Date(),
): { title: string; message: string } | null {
  const ask = 'Tap to add it to your Circls bookings 👇';
  if (b.itemType === 'event' && b.event) {
    const place = placeOf(b.venueId, b.venueName);
    return {
      title: `Your ticket for ${b.event.name}`,
      message: note(
        ask,
        `Hi! Here's your ticket for ${bold(b.event.name)}`,
        `📅 ${formatDayAtTime(b.event.startsAt, b.timeZone)}`,
        place ? `📍 ${place}` : null,
      ),
    };
  }
  if (b.itemType === 'slot') {
    const next = nextCourtSlots(b.slots, now);
    return {
      title: `Your court at ${b.venueName}`,
      message: note(
        ask,
        `Hi! Here's your pass for ${ticketLabel ? `${ticketLabel} at ` : ''}${bold(b.venueName)}`,
        next ? `📅 ${formatDayAtTime(next.startAt, b.timeZone)}` : null,
      ),
    };
  }
  return null;
}

/** What goes on the clipboard where there is no share sheet: the note, then the link. */
export function inviteText(invite: BookingInvite, url: string): string {
  return `${invite.message}\n${url}`;
}

/**
 * The invite for one of the consumer's bookings, or null when there is nothing
 * to invite anyone to: a booking that is unpaid or cancelled, an event or court
 * time that has already ended, or a membership that has run out (its booking
 * stays confirmed after it does).
 */
export function inviteForBooking(b: MyBookingDetail, now: Date = new Date()): BookingInvite | null {
  if (b.status !== 'confirmed') return null;
  const place = placeOf(b.venueId, b.venueName);
  if (b.itemType === 'event' && b.event) {
    if (Date.parse(b.event.endsAt) <= now.getTime()) return null;
    return eventInvite(b.event, place, b.timeZone);
  }
  if (b.itemType === 'slot' && b.venueId) {
    return inviteForCourts({ id: b.venueId, name: b.venueName, timeZone: b.timeZone }, b.slots, now);
  }
  if (b.itemType === 'membership' && b.membership) {
    if (b.membership.endsAt && Date.parse(b.membership.endsAt) <= now.getTime()) return null;
    return membershipInvite(b.membership, place);
  }
  return null;
}

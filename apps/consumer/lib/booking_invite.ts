import type { MyBookingDetail, WishlistItemType } from '@/lib/api/types';

/**
 * "Invite friends" on a booking, the way ticketing apps do it: a short note in
 * the booker's own voice (what they're going to, where and when) and a link to
 * the listing, so friends can see it and book their own place.
 *
 * Only public listing details go in: never the price, the reference, the QR
 * tickets or the booker's answers. The link is the listing's (the event, the
 * venue for a court, the plan), never the booking's, which only its owner can
 * open.
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

/**
 * "Sat, 1 Nov at 7:00 pm". In the viewer's time zone, as the booking page and
 * the listing show it; `timeZone` is for tests.
 */
export function inviteWhen(iso: string, timeZone?: string): string {
  const d = new Date(iso);
  const tz = timeZone ? { timeZone } : {};
  const day = new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short', ...tz }).format(d);
  const time = new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true, ...tz }).format(d);
  return `${day} at ${time}`;
}

const at = (place: string | null | undefined) => (place ? ` at ${place}` : '');

export function eventInvite(
  e: { id: string; name: string; startsAt: string; place?: string | null },
  timeZone?: string,
): BookingInvite {
  return {
    itemType: 'event',
    itemId: e.id,
    title: `Join me at ${e.name}`,
    message: `Hi! I'm going to ${e.name}${at(e.place)} on ${inviteWhen(e.startsAt, timeZone)}. Care to join me?`,
  };
}

/** A court booking links to the venue: friends come to play, not to book the same slot. */
export function courtInvite(
  c: { venueId: string; venueName: string; arenaName: string; startAt: string },
  timeZone?: string,
): BookingInvite {
  return {
    itemType: 'venue',
    itemId: c.venueId,
    title: `Play with me at ${c.venueName}`,
    message: `Hi! I've booked ${c.arenaName} at ${c.venueName} for ${inviteWhen(c.startAt, timeZone)}. Care to join me?`,
  };
}

export function membershipInvite(m: { id: string; name: string; place?: string | null }): BookingInvite {
  return {
    itemType: 'membership',
    itemId: m.id,
    title: `Join me at ${m.place ?? m.name}`,
    message: `Hi! I've joined ${m.name}${at(m.place)}. Care to join me?`,
  };
}

/** What goes on the clipboard where there is no share sheet: the note, then the link. */
export function inviteText(invite: BookingInvite, url: string): string {
  return `${invite.message}\n${url}`;
}

/**
 * The invite for one of the consumer's bookings, or null when there is nothing
 * to invite anyone to: a booking that is unpaid, cancelled or over, or an event
 * or court time that has already ended. A court booking with several slots
 * invites to the next one still to come.
 */
export function inviteForBooking(b: MyBookingDetail, now: Date = new Date(), timeZone?: string): BookingInvite | null {
  if (b.status !== 'confirmed') return null;
  // With no venue, the booking's title falls back to the event's or plan's own
  // name, so it only names a place when there is a venue.
  const place = b.venueId ? b.venueName : null;
  if (b.itemType === 'event' && b.event) {
    if (new Date(b.event.endsAt) <= now) return null;
    return eventInvite({ id: b.event.id, name: b.event.name, startsAt: b.event.startsAt, place }, timeZone);
  }
  if (b.itemType === 'slot' && b.venueId) {
    const next = b.slots.find((s) => new Date(s.endAt) > now);
    if (!next) return null;
    return courtInvite(
      { venueId: b.venueId, venueName: b.venueName, arenaName: next.arenaName, startAt: next.startAt },
      timeZone,
    );
  }
  if (b.itemType === 'membership' && b.membership) {
    return membershipInvite({ id: b.membership.id, name: b.membership.name, place });
  }
  return null;
}

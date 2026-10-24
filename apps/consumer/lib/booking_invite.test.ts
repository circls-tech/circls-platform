import { describe, expect, it } from 'vitest';
import type { MyBookingDetail } from '@/lib/api/types';
import { inviteForBooking, inviteForCourts, inviteForEvent, inviteForMembership, inviteText } from './booking_invite';

// Saturday 7 Nov 2026: 7:00 pm in Bengaluru, 8:30 am in Boston.
const SAT = '2026-11-07T13:30:00.000Z';
const NOW = new Date('2026-10-25T06:00:00.000Z');

function booking(overrides: Partial<MyBookingDetail>): MyBookingDetail {
  return {
    id: 'bk_1',
    venueId: 'ven_1',
    venueName: 'Smash Arena',
    itemType: 'event',
    status: 'confirmed',
    channel: 'consumer_app',
    paymentMethod: 'razorpay_route',
    totalPaise: 49900,
    currency: 'INR',
    note: null,
    customerName: 'Asha',
    customerContact: '+919800000000',
    createdAt: '2026-10-20T10:00:00.000Z',
    timeZone: 'Asia/Kolkata',
    slots: [],
    event: null,
    membership: null,
    qrTickets: [],
    ...overrides,
  };
}

const event = {
  id: 'evt_1',
  name: 'Sunday Smash',
  startsAt: SAT,
  endsAt: '2026-11-07T16:30:00.000Z',
  description: null,
  answers: [{ label: 'T-shirt size', answer: 'M' }],
  postBookingRedirect: null,
};

const slot = (arenaName: string, startAt: string, endAt: string) => ({
  id: `s_${arenaName}_${startAt}`,
  startAt,
  endAt,
  pricePaise: 50000,
  arenaName,
});

describe('checkout invites (from the listing)', () => {
  it('an event names the event, its venue and the time where it happens, and links to the event', () => {
    const ev = { id: 'evt_1', name: 'Sunday Smash', startsAt: SAT, venueId: 'ven_1', venueName: 'Smash Arena', locTzName: 'Asia/Kolkata' };
    expect(inviteForEvent(ev)).toEqual({
      itemType: 'event',
      itemId: 'evt_1',
      title: 'Join me at Sunday Smash',
      message: "Hi! I'm going to Sunday Smash at Smash Arena on Sat, 7 Nov at 7:00 pm. Care to join me?",
    });
  });

  it("writes the time in the event's zone, whatever the sender's", () => {
    const ev = { id: 'evt_2', name: 'Harbor Hoops', startsAt: SAT, venueId: 'ven_2', venueName: 'Harbor Yard', locTzName: 'America/New_York' };
    expect(inviteForEvent(ev).message).toBe(
      "Hi! I'm going to Harbor Hoops at Harbor Yard on Sat, 7 Nov at 8:30 am. Care to join me?",
    );
  });

  it('an event with no venue leaves the place out', () => {
    const ev = { id: 'evt_3', name: 'City 10K', startsAt: SAT, venueId: null, venueName: null, locTzName: 'Asia/Kolkata' };
    expect(inviteForEvent(ev).message).toBe("Hi! I'm going to City 10K on Sat, 7 Nov at 7:00 pm. Care to join me?");
  });

  it('a membership names the plan and, for a venue plan only, the venue', () => {
    expect(inviteForMembership({ id: 'mem_1', name: 'Gold Monthly', venueId: 'ven_1', scopeName: 'Smash Arena' })).toEqual({
      itemType: 'membership',
      itemId: 'mem_1',
      title: 'Join me at Smash Arena',
      message: "Hi! I've joined Gold Monthly at Smash Arena. Care to join me?",
    });
    // A brand-wide plan's scope is the brand, which is no place to meet.
    expect(inviteForMembership({ id: 'mem_2', name: 'Acme Pass', venueId: null, scopeName: 'Acme' })).toMatchObject({
      title: 'Join me at Acme Pass',
      message: "Hi! I've joined Acme Pass. Care to join me?",
    });
  });

  it('a cart links to the venue and names its earliest slot, in any order', () => {
    const venue = { id: 'ven_1', name: 'Smash Arena', timeZone: 'Asia/Kolkata' };
    const cart = [
      slot('Court 1', '2026-11-07T14:30:00.000Z', '2026-11-07T15:30:00.000Z'),
      slot('Court 2', SAT, '2026-11-07T14:30:00.000Z'),
    ];
    expect(inviteForCourts(venue, cart, NOW)).toEqual({
      itemType: 'venue',
      itemId: 'ven_1',
      title: 'Play with me at Smash Arena',
      message: "Hi! I've booked Court 2 at Smash Arena for Sat, 7 Nov at 7:00 pm. Care to join me?",
    });
  });

  it('names every court booked for that time', () => {
    const venue = { id: 'ven_1', name: 'Smash Arena', timeZone: 'Asia/Kolkata' };
    const end = '2026-11-07T14:30:00.000Z';
    const two = [slot('Court 2', SAT, end), slot('Court 1', SAT, end), slot('Court 1', end, '2026-11-07T15:30:00.000Z')];
    expect(inviteForCourts(venue, two, NOW)?.message).toBe(
      "Hi! I've booked Court 2 and Court 1 at Smash Arena for Sat, 7 Nov at 7:00 pm. Care to join me?",
    );
    const three = [slot('A', SAT, end), slot('B', SAT, end), slot('C', SAT, end)];
    expect(inviteForCourts(venue, three, NOW)?.message).toContain("I've booked A, B and C at");
  });

  it('the copied text is the note, then the link', () => {
    const invite = inviteForMembership({ id: 'mem_1', name: 'Gold Monthly', venueId: null, scopeName: 'Acme' });
    expect(inviteText(invite, 'https://circls.app/memberships/mem_1')).toBe(
      "Hi! I've joined Gold Monthly. Care to join me?\nhttps://circls.app/memberships/mem_1",
    );
  });
});

describe('inviteForBooking', () => {
  it('invites to a confirmed, upcoming event, in the booking’s zone', () => {
    expect(inviteForBooking(booking({ event }), NOW)?.message).toBe(
      "Hi! I'm going to Sunday Smash at Smash Arena on Sat, 7 Nov at 7:00 pm. Care to join me?",
    );
    expect(inviteForBooking(booking({ event, timeZone: 'America/New_York' }), NOW)?.message).toContain(
      'on Sat, 7 Nov at 8:30 am',
    );
  });

  it('never carries the price, the reference or the answers', () => {
    const invite = inviteForBooking(booking({ event }), NOW)!;
    const all = `${invite.title} ${invite.message}`;
    expect(all).not.toMatch(/499|bk_1|T-shirt|Asha/);
  });

  it('leaves the place out when the booking has no venue', () => {
    // The API titles a venue-less booking with the event's own name.
    const invite = inviteForBooking(booking({ event, venueId: null, venueName: 'Sunday Smash' }), NOW);
    expect(invite?.message).toBe("Hi! I'm going to Sunday Smash on Sat, 7 Nov at 7:00 pm. Care to join me?");
  });

  it('has nothing to say for a booking that is not confirmed', () => {
    for (const status of ['pending', 'cancelled', 'completed', 'no_show']) {
      expect(inviteForBooking(booking({ event, status }), NOW)).toBeNull();
    }
  });

  it('has nothing to say once the event is over', () => {
    expect(inviteForBooking(booking({ event }), new Date(event.endsAt))).toBeNull();
  });

  it('invites to the next court slot still to come', () => {
    const slots = [
      slot('Court 1', '2026-10-24T12:30:00.000Z', '2026-10-24T13:30:00.000Z'),
      slot('Court 2', SAT, '2026-11-07T14:30:00.000Z'),
    ];
    expect(inviteForBooking(booking({ itemType: 'slot', slots }), NOW)).toEqual({
      itemType: 'venue',
      itemId: 'ven_1',
      title: 'Play with me at Smash Arena',
      message: "Hi! I've booked Court 2 at Smash Arena for Sat, 7 Nov at 7:00 pm. Care to join me?",
    });
    expect(inviteForBooking(booking({ itemType: 'slot', slots }), new Date('2026-11-08T00:00:00Z'))).toBeNull();
  });

  it('invites to a membership, naming the venue only for a venue plan', () => {
    const membership = { id: 'mem_1', name: 'Gold Monthly', durationDays: 30, description: null, endsAt: '2026-11-20T00:00:00.000Z' };
    expect(inviteForBooking(booking({ itemType: 'membership', membership }), NOW)?.message).toBe(
      "Hi! I've joined Gold Monthly at Smash Arena. Care to join me?",
    );
    expect(
      inviteForBooking(booking({ itemType: 'membership', membership, venueId: null, venueName: 'Gold Monthly' }), NOW)
        ?.message,
    ).toBe("Hi! I've joined Gold Monthly. Care to join me?");
  });

  it('has nothing to say once the membership has run out, though its booking stays confirmed', () => {
    const membership = { id: 'mem_1', name: 'Gold Monthly', durationDays: 30, description: null, endsAt: '2026-02-01T00:00:00.000Z' };
    expect(inviteForBooking(booking({ itemType: 'membership', membership }), NOW)).toBeNull();
  });
});

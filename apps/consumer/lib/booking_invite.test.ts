import { describe, expect, it } from 'vitest';
import type { MyBookingDetail } from '@/lib/api/types';
import { courtInvite, eventInvite, inviteForBooking, inviteText, inviteWhen, membershipInvite } from './booking_invite';

const IST = 'Asia/Kolkata';
// Saturday 7 Nov 2026, 7:00 pm in Bengaluru.
const SAT_7PM = '2026-11-07T13:30:00.000Z';
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
  startsAt: SAT_7PM,
  endsAt: '2026-11-07T16:30:00.000Z',
  description: null,
  answers: [{ label: 'T-shirt size', answer: 'M' }],
  postBookingRedirect: null,
};

describe('inviteWhen', () => {
  it('reads as a day and a time', () => {
    expect(inviteWhen(SAT_7PM, IST)).toBe('Sat, 7 Nov at 7:00 pm');
  });
});

describe('the invite notes', () => {
  it('an event names the event, the place and the time, and links to the event', () => {
    expect(eventInvite({ id: 'evt_1', name: 'Sunday Smash', startsAt: SAT_7PM, place: 'Smash Arena' }, IST)).toEqual({
      itemType: 'event',
      itemId: 'evt_1',
      title: 'Join me at Sunday Smash',
      message: "Hi! I'm going to Sunday Smash at Smash Arena on Sat, 7 Nov at 7:00 pm. Care to join me?",
    });
  });

  it('an event with no venue leaves the place out', () => {
    expect(eventInvite({ id: 'evt_1', name: 'City 10K', startsAt: SAT_7PM, place: null }, IST).message).toBe(
      "Hi! I'm going to City 10K on Sat, 7 Nov at 7:00 pm. Care to join me?",
    );
  });

  it('a court links to the venue', () => {
    expect(
      courtInvite({ venueId: 'ven_1', venueName: 'Smash Arena', arenaName: 'Court 2', startAt: SAT_7PM }, IST),
    ).toEqual({
      itemType: 'venue',
      itemId: 'ven_1',
      title: 'Play with me at Smash Arena',
      message: "Hi! I've booked Court 2 at Smash Arena for Sat, 7 Nov at 7:00 pm. Care to join me?",
    });
  });

  it('a membership names the plan and, for a venue plan, the venue', () => {
    expect(membershipInvite({ id: 'mem_1', name: 'Gold Monthly', place: 'Smash Arena' })).toEqual({
      itemType: 'membership',
      itemId: 'mem_1',
      title: 'Join me at Smash Arena',
      message: "Hi! I've joined Gold Monthly at Smash Arena. Care to join me?",
    });
    expect(membershipInvite({ id: 'mem_1', name: 'Acme Pass', place: null })).toMatchObject({
      title: 'Join me at Acme Pass',
      message: "Hi! I've joined Acme Pass. Care to join me?",
    });
  });

  it('the copied text is the note, then the link', () => {
    const invite = membershipInvite({ id: 'mem_1', name: 'Gold Monthly' });
    expect(inviteText(invite, 'https://circls.app/memberships/mem_1')).toBe(
      "Hi! I've joined Gold Monthly. Care to join me?\nhttps://circls.app/memberships/mem_1",
    );
  });
});

describe('inviteForBooking', () => {
  it('invites to a confirmed, upcoming event', () => {
    expect(inviteForBooking(booking({ event }), NOW, IST)?.message).toBe(
      "Hi! I'm going to Sunday Smash at Smash Arena on Sat, 7 Nov at 7:00 pm. Care to join me?",
    );
  });

  it('never carries the price, the reference or the answers', () => {
    const invite = inviteForBooking(booking({ event }), NOW, IST)!;
    const all = `${invite.title} ${invite.message}`;
    expect(all).not.toMatch(/499|bk_1|T-shirt|Asha/);
  });

  it('leaves the place out when the booking has no venue', () => {
    // The API titles a venue-less booking with the event's own name.
    const invite = inviteForBooking(booking({ event, venueId: null, venueName: 'Sunday Smash' }), NOW, IST);
    expect(invite?.message).toBe("Hi! I'm going to Sunday Smash on Sat, 7 Nov at 7:00 pm. Care to join me?");
  });

  it('has nothing to say for a booking that is not confirmed', () => {
    for (const status of ['pending', 'cancelled', 'completed', 'no_show']) {
      expect(inviteForBooking(booking({ event, status }), NOW, IST)).toBeNull();
    }
  });

  it('has nothing to say once the event is over', () => {
    expect(inviteForBooking(booking({ event }), new Date(event.endsAt), IST)).toBeNull();
  });

  it('invites to the next court slot still to come', () => {
    const slots = [
      { id: 's1', startAt: '2026-10-24T12:30:00.000Z', endAt: '2026-10-24T13:30:00.000Z', pricePaise: 50000, arenaName: 'Court 1' },
      { id: 's2', startAt: SAT_7PM, endAt: '2026-11-07T14:30:00.000Z', pricePaise: 50000, arenaName: 'Court 2' },
    ];
    expect(inviteForBooking(booking({ itemType: 'slot', slots }), NOW, IST)).toEqual({
      itemType: 'venue',
      itemId: 'ven_1',
      title: 'Play with me at Smash Arena',
      message: "Hi! I've booked Court 2 at Smash Arena for Sat, 7 Nov at 7:00 pm. Care to join me?",
    });
    expect(inviteForBooking(booking({ itemType: 'slot', slots }), new Date('2026-11-08T00:00:00Z'), IST)).toBeNull();
  });

  it('invites to a membership, naming the venue only for a venue plan', () => {
    const membership = { id: 'mem_1', name: 'Gold Monthly', durationDays: 30, description: null };
    expect(inviteForBooking(booking({ itemType: 'membership', membership }), NOW)?.message).toBe(
      "Hi! I've joined Gold Monthly at Smash Arena. Care to join me?",
    );
    expect(
      inviteForBooking(booking({ itemType: 'membership', membership, venueId: null, venueName: 'Gold Monthly' }), NOW)
        ?.message,
    ).toBe("Hi! I've joined Gold Monthly. Care to join me?");
  });
});

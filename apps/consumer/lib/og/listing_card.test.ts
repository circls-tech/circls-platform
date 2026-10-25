import { describe, expect, it } from 'vitest';
import type { PublicEventWithVenue, PublicMembershipWithScope, VenueDetail } from '@/lib/api/types';
import { eventCard, membershipCard, venueCard } from './listing_card';

// Saturday 7 Nov 2026: 7:00 pm in Bengaluru, 8:30 am in Boston.
const SAT = '2026-11-07T13:30:00.000Z';

const event = (over: Partial<PublicEventWithVenue>) =>
  ({
    id: 'evt_1',
    name: 'Sunday Smash',
    startsAt: SAT,
    venueId: 'ven_1',
    venueName: 'Smash Arena',
    locationName: 'Smash Arena',
    locTzName: 'Asia/Kolkata',
    venueTags: ['Badminton'],
    images: [],
    ...over,
  }) as unknown as PublicEventWithVenue;

describe('eventCard', () => {
  it('says when (in the event’s zone) and where, and links to the event', () => {
    expect(eventCard(event({}))).toEqual({
      kind: 'Event',
      title: 'Sunday Smash',
      lines: ['Sat, 7 Nov at 7:00 pm', 'Smash Arena'],
      description: 'Sat, 7 Nov at 7:00 pm · Smash Arena',
      pictures: ['/sports/badminton.jpg'],
      path: '/events/evt_1',
    });
    expect(eventCard(event({ locTzName: 'America/New_York' })).lines[0]).toBe('Sat, 7 Nov at 8:30 am');
  });

  it('uses the cover photo first, and the organiser for a venue-less event', () => {
    const c = eventCard(
      event({
        venueId: null,
        venueName: null,
        locationName: 'Acme Runners',
        images: [
          { url: 'https://img/2.jpg', position: 1, width: null, height: null, focalX: 0.5, focalY: 0.5 },
          { url: 'https://img/1.jpg', position: 0, width: null, height: null, focalX: 0.5, focalY: 0.5 },
        ],
      }),
    );
    expect(c.pictures).toEqual(['https://img/1.jpg', '/sports/badminton.jpg']);
    expect(c.lines[1]).toBe('Acme Runners');
  });

  it('has no picture when there is neither a photo nor a sport, and skips an undated line', () => {
    const c = eventCard(event({ startsAt: '', venueTags: ['Quiz night'] }));
    expect(c.pictures).toEqual([]);
    expect(c.lines).toEqual(['Smash Arena']);
  });
});

describe('venueCard', () => {
  it('says where and what is played there', () => {
    const detail = {
      venue: {
        id: 'ven_1',
        name: 'Smash Arena',
        tags: ['badminton', 'Squash', 'pickleball', 'Gym'],
        images: [],
        addressJson: null,
        address: { line1: null, line2: null, city: 'Bengaluru', state: null, postalCode: null, country: 'India' },
      },
      arenas: [],
    } as unknown as VenueDetail;
    expect(venueCard(detail)).toMatchObject({
      kind: 'Venue',
      title: 'Smash Arena',
      lines: ['Bengaluru', 'Badminton · Squash · Pickleball'],
      pictures: ['/sports/badminton.jpg'],
      path: '/venues/ven_1',
    });
  });
});

describe('membershipCard', () => {
  const plan = (over: Partial<PublicMembershipWithScope>) =>
    ({
      id: 'mem_1',
      name: 'Gold Monthly',
      venueId: 'ven_1',
      scopeName: 'Smash Arena',
      durationDays: 30,
      artworkUrl: null,
      venueTags: ['Tennis'],
      brand: { id: 'b1', slug: 'acme', name: 'Acme Sports', logoUrl: null },
      ...over,
    }) as unknown as PublicMembershipWithScope;

  it('names the venue for a venue plan, the brand for a brand-wide one', () => {
    expect(membershipCard(plan({}))).toMatchObject({
      kind: 'Membership',
      lines: ['Smash Arena', '30-day plan'],
      pictures: ['/sports/tennis.jpg'],
      path: '/memberships/mem_1',
    });
    expect(membershipCard(plan({ venueId: null, scopeName: 'Acme Sports' })).lines[0]).toBe('Acme Sports');
  });

  it('prefers the plan’s own artwork', () => {
    expect(membershipCard(plan({ artworkUrl: 'https://img/plan.png' })).pictures).toEqual(['https://img/plan.png', '/sports/tennis.jpg']);
  });
});

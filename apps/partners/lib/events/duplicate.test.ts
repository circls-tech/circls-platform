import { describe, expect, it } from 'vitest';
import type { VenueEvent } from '@/lib/api/types';
import { addressDraftFromApi, duplicateDraftFromEvent } from './duplicate';

function event(overrides: Partial<VenueEvent> = {}): VenueEvent {
  return {
    id: 'ev-1',
    tenantId: 't-1',
    venueId: 'v-1',
    addressJson: null,
    lat: null,
    lng: null,
    tzName: null,
    name: 'Sunday Football',
    description: 'Casual 5-a-side',
    startsAt: '2026-10-21T16:32:00.000Z',
    endsAt: '2026-10-21T18:32:00.000Z',
    pricePaise: 15000,
    capacity: null,
    maxPerUser: 4,
    status: 'completed',
    qrTicketConfig: null,
    postBookingRedirect: { url: 'https://example.com/waiver', description: null, forced: false },
    seriesId: 'series-1',
    archivedAt: '2026-10-23T00:00:00.000Z',
    tiers: [
      {
        id: 'tier-live-1',
        name: 'Gold',
        description: 'Front-line spot',
        pricePaise: 50000,
        capacity: 20,
        qrTicketConfig: null,
        sold: 12,
        remaining: 8,
      },
      {
        id: 'tier-live-2',
        name: 'Bronze',
        description: null,
        pricePaise: 15000,
        capacity: null,
        qrTicketConfig: { enabled: false } as VenueEvent['qrTicketConfig'],
        sold: 0,
        remaining: null,
      },
    ],
    questions: [
      { id: 'q-1', label: 'T-shirt size', type: 'select', required: true, options: ['S', 'M'], sortOrder: 0 },
    ],
    ...overrides,
  };
}

describe('duplicateDraftFromEvent', () => {
  it('seeds a venue event without live tier ids, dates, series or archive state', () => {
    const draft = duplicateDraftFromEvent(event());
    expect(draft.scope).toBe('venue');
    expect(draft.venueId).toBe('v-1');
    expect(draft.name).toBe('Sunday Football');
    expect(draft.description).toBe('Casual 5-a-side');
    expect(draft.maxPerUser).toBe('4');
    expect(draft.redirect).toEqual({ url: 'https://example.com/waiver', description: null, forced: false });
    expect(draft.tiers.map((t) => t.id)).toEqual([undefined, undefined]);
    expect(draft.tiers.map((t) => [t.name, t.priceRupees, t.capacity, t.qrMode])).toEqual([
      ['Gold', '500', '20', 'inherit'],
      ['Bronze', '150', '', 'off'],
    ]);
    expect(draft.questions).toEqual([
      { label: 'T-shirt size', type: 'select', required: true, optionsText: 'S, M' },
    ]);
    expect(draft).not.toHaveProperty('startsAt');
    expect(draft).not.toHaveProperty('seriesId');
  });

  it('seeds a standalone event from its address, timezone and pin', () => {
    const draft = duplicateDraftFromEvent(
      event({
        venueId: null,
        addressJson: { line1: '12 MG Road', city: 'Bengaluru', state: 'KA', pincode: '560001', country: 'India', landmark: 7 },
        lat: 12.97,
        lng: 77.59,
        tzName: 'Asia/Kolkata',
        tiers: [],
        questions: [],
        maxPerUser: null,
      }),
    );
    expect(draft.scope).toBe('standalone');
    expect(draft.venueId).toBe('');
    expect(draft.address).toEqual({
      line1: '12 MG Road',
      line2: '',
      city: 'Bengaluru',
      state: 'KA',
      pincode: '560001',
      country: 'India',
      tz: 'Asia/Kolkata',
      coords: { lat: 12.97, lng: 77.59 },
    });
    // An event with no tiers still gives the form one blank row to fill.
    expect(draft.tiers).toHaveLength(1);
    expect(draft.tiers[0]!.name).toBe('');
    expect(draft.maxPerUser).toBeNull();
  });
});

describe('addressDraftFromApi', () => {
  it('falls back to blanks, the default timezone and no pin', () => {
    expect(addressDraftFromApi({ addressJson: null, lat: 12.9, lng: null, tzName: null })).toEqual({
      line1: '',
      line2: '',
      city: '',
      state: '',
      pincode: '',
      country: '',
      tz: 'Asia/Kolkata',
      coords: null,
    });
  });
});

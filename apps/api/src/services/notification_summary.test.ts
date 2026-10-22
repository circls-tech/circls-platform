import { describe, expect, it } from 'vitest';
import { formatMoney, formatWhen } from '../lib/notifications/email_format.js';
import { bookingSummary, type BookingNotifyContext } from './notification_service.js';

const base: BookingNotifyContext = {
  bookingId: 'b-1',
  tenantId: 't-1',
  customerName: 'Shivam Singh',
  customerUserId: null,
  phone: null,
  email: 'shivam@example.com',
  itemType: 'slot',
  venueName: 'Tigers Arena',
  arenaName: 'Court 1',
  startAt: new Date('2026-10-04T13:30:00Z'),
  endAt: new Date('2026-10-04T14:30:00Z'),
  tz: 'Asia/Kolkata',
  currency: 'INR',
  totalPaise: 120000,
  totalRupees: '1200.00',
  eventName: null,
  eventWhere: null,
  tickets: null,
  membershipName: null,
  membershipTier: null,
  membershipStartsAt: null,
  membershipEndsAt: null,
  whenText: 'Sun 4 Oct, 7:00–8:00 PM',
};

describe('bookingSummary', () => {
  it('a court slot: venue, arena, time and total', () => {
    const s = bookingSummary(base);
    expect(s.itemName).toBe('Tigers Arena · Court 1');
    expect(s.details).toBe('Venue: Tigers Arena\nArena: Court 1\nWhen: Sun 4 Oct, 7:00–8:00 PM\nTotal: ₹1,200');
  });

  it('a free event: its own name, place, time and tickets — no arena', () => {
    const s = bookingSummary({
      ...base,
      itemType: 'event',
      venueName: 'Tan Coffee',
      arenaName: '',
      eventName: 'Coffee Tasting',
      eventWhere: 'Tan Coffee',
      tickets: '1 × General',
      totalPaise: 0,
      totalRupees: '0.00',
      startAt: new Date('2026-10-25T11:30:00Z'),
      endAt: null,
      whenText: 'Sun 25 Oct, 5:00 PM',
    });
    expect(s.itemName).toBe('Coffee Tasting');
    expect(s.details).toBe(
      'Event: Coffee Tasting\nWhere: Tan Coffee\nWhen: Sun 25 Oct, 5:00 PM\nTickets: 1 × General\nTotal: Free',
    );
    expect(s.details).not.toContain('Arena');
  });

  it('an event with no date yet says so instead of a blank', () => {
    const s = bookingSummary({ ...base, itemType: 'event', eventName: 'Pop-up', startAt: null, whenText: 'your booked time' });
    expect(s.details).toContain('When: Date to be announced');
  });

  it('a membership: plan and validity window, no venue or arena', () => {
    const s = bookingSummary({
      ...base,
      itemType: 'membership',
      membershipName: 'Run Club',
      membershipTier: 'Monthly',
      membershipStartsAt: new Date('2026-11-01T00:00:00Z'),
      membershipEndsAt: new Date('2026-11-30T00:00:00Z'),
      startAt: null,
      whenText: 'Sun 1 Nov 2026 – Mon 30 Nov 2026',
      totalPaise: 50000,
    });
    expect(s.itemName).toBe('Run Club · Monthly');
    expect(s.details).toBe('Plan: Run Club · Monthly\nValid: Sun 1 Nov 2026 – Mon 30 Nov 2026\nTotal: ₹500');
  });

  it('a slot with no arena left (slots released) drops the empty row', () => {
    expect(bookingSummary({ ...base, arenaName: '' }).details).not.toContain('Arena:');
  });
});

describe('formatWhen / formatMoney', () => {
  it('shows a same-day range in the venue’s time zone', () => {
    expect(formatWhen(new Date('2026-10-04T13:30:00Z'), new Date('2026-10-04T14:30:00Z'), 'Asia/Kolkata')).toBe(
      'Sun 4 Oct, 7:00–8:00 PM',
    );
    expect(formatWhen(new Date('2026-10-04T22:00:00Z'), null, 'America/New_York')).toBe('Sun 4 Oct, 6:00 PM');
  });

  it('groups rupees the Indian way and drops zero paise', () => {
    expect(formatMoney(18435000, 'INR')).toBe('₹1,84,350');
    expect(formatMoney(79850, 'INR')).toBe('₹798.50');
    expect(formatMoney(120000, 'USD')).toBe('$1,200');
  });
});

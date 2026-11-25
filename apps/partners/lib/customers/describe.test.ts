import { describe, expect, it } from 'vitest';
import { describeCustomer, lastSeenLabel } from './describe';

describe('describeCustomer', () => {
  it('counts visits and names what they were for, in a fixed order', () => {
    expect(describeCustomer({ timesSeen: 3, kinds: ['event', 'slot'] })).toBe(
      '3 visits · court bookings, events',
    );
    expect(describeCustomer({ timesSeen: 1, kinds: ['membership'] })).toBe('1 visit · membership');
  });

  it('copes with a row that names no kind', () => {
    expect(describeCustomer({ timesSeen: 2, kinds: [] })).toBe('2 visits');
  });
});

describe('lastSeenLabel', () => {
  it('shows the date in the given zone', () => {
    // 23:30 UTC on the 12th is already the 13th in Kolkata.
    expect(lastSeenLabel('2026-11-12T23:30:00.000Z', 'Asia/Kolkata')).toBe('Last seen 13 Nov 2026');
    expect(lastSeenLabel('2026-11-12T23:30:00.000Z', 'UTC')).toBe('Last seen 12 Nov 2026');
  });

  it('says nothing for an unparseable instant', () => {
    expect(lastSeenLabel('nope', 'UTC')).toBe('');
  });
});

import { describe, expect, it } from 'vitest';
import {
  formatAddress,
  socialLinks,
  membershipScope,
  formatOpeningHours,
  type AddressLike,
} from './trust';

// The consumer vitest runs in a node-only environment (no jsdom), so these
// cover the pure prop-shaping logic behind the trust components; the React
// rendering itself is exercised by `next build` / type-checking.

const fullAddress: AddressLike = {
  line1: '12 MG Road',
  line2: 'Indiranagar',
  city: 'Bengaluru',
  state: 'KA',
  postalCode: '560038',
  country: 'India',
};

describe('formatAddress', () => {
  it('joins all present parts in order', () => {
    expect(formatAddress(fullAddress)).toBe('12 MG Road, Indiranagar, Bengaluru, KA, 560038, India');
  });
  it('skips blank/whitespace-only and null parts', () => {
    expect(
      formatAddress({ line1: '  ', line2: null, city: 'Pune', state: '', postalCode: null, country: 'India' }),
    ).toBe('Pune, India');
  });
  it('returns null when nothing is set', () => {
    expect(
      formatAddress({ line1: null, line2: null, city: '', state: null, postalCode: '  ', country: null }),
    ).toBeNull();
    expect(formatAddress(null)).toBeNull();
    expect(formatAddress(undefined)).toBeNull();
  });
});

describe('socialLinks', () => {
  it('normalizes bare handles (and @handles) into full URLs in a fixed order', () => {
    expect(
      socialLinks({ x: '@acme', instagram: 'acme.club', youtube: 'acmechannel', facebook: 'acmefc' }),
    ).toEqual([
      { key: 'instagram', label: 'Instagram', href: 'https://instagram.com/acme.club' },
      { key: 'facebook', label: 'Facebook', href: 'https://facebook.com/acmefc' },
      { key: 'x', label: 'X', href: 'https://x.com/acme' },
      { key: 'youtube', label: 'YouTube', href: 'https://youtube.com/@acmechannel' },
    ]);
  });
  it('passes through values that are already absolute URLs', () => {
    expect(socialLinks({ instagram: 'https://instagram.com/acme' })).toEqual([
      { key: 'instagram', label: 'Instagram', href: 'https://instagram.com/acme' },
    ]);
  });
  it('skips blank fields and returns [] for null/empty', () => {
    expect(socialLinks({ instagram: '   ', facebook: '' })).toEqual([]);
    expect(socialLinks(null)).toEqual([]);
    expect(socialLinks(undefined)).toEqual([]);
  });
});

describe('membershipScope', () => {
  it('uses the venue name for venue-scoped plans', () => {
    expect(membershipScope({ venueId: 'v1', scopeName: 'Smash Arena' })).toEqual({
      label: 'Smash Arena',
      brandWide: false,
    });
  });
  it('labels venue-less plans Brand-wide', () => {
    expect(membershipScope({ venueId: null, scopeName: 'Acme Sports' })).toEqual({
      label: 'Brand-wide',
      brandWide: true,
    });
  });
});

describe('formatOpeningHours', () => {
  it('returns null when hours are absent', () => {
    expect(formatOpeningHours(null)).toBeNull();
    expect(formatOpeningHours(undefined)).toBeNull();
  });
  it('orders Monday-first and marks missing/empty days closed', () => {
    const rows = formatOpeningHours({
      '1': [{ open: '09:00', close: '17:00' }],
      '0': [{ open: '10:00', close: '14:00' }],
    });
    expect(rows).not.toBeNull();
    expect(rows!.map((r) => r.day)).toEqual([
      'Monday',
      'Tuesday',
      'Wednesday',
      'Thursday',
      'Friday',
      'Saturday',
      'Sunday',
    ]);
    expect(rows![0]).toEqual({ day: 'Monday', label: '09:00–17:00', closed: false });
    expect(rows![6]).toEqual({ day: 'Sunday', label: '10:00–14:00', closed: false });
    expect(rows![1]).toEqual({ day: 'Tuesday', label: 'Closed', closed: true });
  });
  it('joins multiple intervals for a day with a comma', () => {
    const rows = formatOpeningHours({
      '2': [
        { open: '09:00', close: '12:00' },
        { open: '15:00', close: '20:00' },
      ],
    });
    const tue = rows!.find((r) => r.day === 'Tuesday')!;
    expect(tue.label).toBe('09:00–12:00, 15:00–20:00');
    expect(tue.closed).toBe(false);
  });
});

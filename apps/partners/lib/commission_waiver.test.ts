import { describe, expect, it } from 'vitest';
import type { CommissionWaiver } from '@/lib/api/types';
import { waiverBanner } from './commission_waiver';

const base: CommissionWaiver = {
  status: 'not_started',
  startsOn: null,
  endsOn: null,
  firstPaidOn: null,
  startSetByAdmin: false,
  endSetByAdmin: false,
  afterWaiverBps: null,
  today: '2026-10-24',
  months: 3,
};

describe('waiverBanner', () => {
  it('before the first paid booking: promises the months, from the API', () => {
    expect(waiverBanner(base)).toEqual({
      highlight: true,
      title: 'Your first 3 months are commission-free',
      body: 'The 3 months start with your first paid booking: from then, Circls takes no commission on your sales.',
    });
    expect(waiverBanner({ ...base, months: 6 })?.title).toBe('Your first 6 months are commission-free');
  });

  it('before the first paid booking with an end circls fixed: states that end', () => {
    const b = waiverBanner({ ...base, endsOn: '2027-03-31', endSetByAdmin: true });
    expect(b?.title).toBe('Commission-free until 31 March 2027');
    expect(b?.body).toContain('starts with your first paid booking and runs until 31 March 2027');
    expect(b?.body).not.toContain('3 months');
  });

  it('a start circls set in the future', () => {
    const b = waiverBanner({ ...base, startsOn: '2026-11-01', endsOn: '2027-02-01', startSetByAdmin: true });
    expect(b?.title).toBe('Commission-free from 1 November 2026');
    expect(b?.body).toContain('from 1 November 2026 until 1 February 2027');
  });

  it('during the period, from the first paid booking, with the agreed rate', () => {
    const b = waiverBanner({
      ...base,
      status: 'active',
      startsOn: '2026-10-01',
      endsOn: '2027-01-01',
      firstPaidOn: '2026-10-01',
      afterWaiverBps: 250,
    });
    expect(b).toEqual({
      highlight: true,
      title: 'Commission-free until 1 January 2027',
      body:
        'Circls takes no commission on your sales until then. Your commission-free period started on 1 October 2026, the day of your first paid booking. From 1 January 2027, Circls’ commission is 2.5% of each sale.',
    });
  });

  it('during the period with a start circls set: no first-booking claim, agreement fallback', () => {
    const b = waiverBanner({
      ...base,
      status: 'active',
      startsOn: '2026-10-01',
      endsOn: '2027-01-01',
      startSetByAdmin: true,
    });
    expect(b?.body).not.toContain('first paid booking');
    expect(b?.body).toContain('commission applies at the rate in your Partner Agreement');
  });

  it('after it ends: a plain note, never "commission-free until"', () => {
    const b = waiverBanner({ ...base, status: 'ended', startsOn: '2026-07-17', endsOn: '2026-10-17' });
    expect(b).toEqual({
      highlight: false,
      title: null,
      body: 'Your commission-free period ended on 17 October 2026. Commission now applies at the rate in your Partner Agreement.',
    });
    expect(
      waiverBanner({ ...base, status: 'ended', endsOn: '2026-10-17', afterWaiverBps: 500 })?.body,
    ).toContain('Circls’ commission is now 5% of each sale.');
  });
});

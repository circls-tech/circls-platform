import { describe, expect, it } from 'vitest';
import { addMonths, dayIn, resolveCommissionWaiver } from './commission_waiver.js';

const base = {
  startsOn: null,
  endsOn: null,
  afterWaiverBps: null,
  firstPaidAt: null,
  tz: 'Asia/Kolkata',
};
const NOW = new Date('2026-10-24T06:00:00Z');

describe('addMonths', () => {
  it('adds calendar months', () => {
    expect(addMonths('2026-10-24', 3)).toBe('2027-01-24');
  });
  it('clamps to the last day of a shorter month, like Postgres', () => {
    expect(addMonths('2026-11-30', 3)).toBe('2027-02-28');
    expect(addMonths('2027-11-30', 3)).toBe('2028-02-29');
    expect(addMonths('2026-10-31', 3)).toBe('2027-01-31');
  });
});

describe('dayIn', () => {
  it('cuts the day in the given zone', () => {
    // 20:00 UTC on the 1st is already the 2nd in India.
    expect(dayIn('Asia/Kolkata', new Date('2026-11-01T20:00:00Z'))).toBe('2026-11-02');
    expect(dayIn('America/New_York', new Date('2026-11-02T02:00:00Z'))).toBe('2026-11-01');
  });
  it('falls back to IST for a malformed zone', () => {
    expect(dayIn('Not/AZone', new Date('2026-11-01T20:00:00Z'))).toBe('2026-11-02');
  });
});

describe('resolveCommissionWaiver', () => {
  it('has not started before the first paid booking', () => {
    const w = resolveCommissionWaiver(base, NOW);
    expect(w).toMatchObject({ status: 'not_started', startsOn: null, endsOn: null, firstPaidOn: null });
  });

  it('starts on the first paid booking and runs 3 months', () => {
    const w = resolveCommissionWaiver(
      { ...base, firstPaidAt: new Date('2026-09-10T20:00:00Z') },
      NOW,
    );
    expect(w).toMatchObject({
      status: 'active',
      startsOn: '2026-09-11', // 01:30 IST on the 11th
      endsOn: '2026-12-11',
      firstPaidOn: '2026-09-11',
      startSetByAdmin: false,
      endSetByAdmin: false,
    });
  });

  it('ends ON the end date — commission starts that day', () => {
    const firstPaidAt = new Date('2026-07-24T06:00:00Z');
    expect(resolveCommissionWaiver({ ...base, firstPaidAt }, NOW).status).toBe('ended');
    expect(
      resolveCommissionWaiver({ ...base, firstPaidAt }, new Date('2026-10-23T12:00:00Z')).status,
    ).toBe('active');
  });

  it('lets an admin move the start, and the default end follows it', () => {
    const w = resolveCommissionWaiver(
      { ...base, startsOn: '2026-10-01', firstPaidAt: new Date('2026-06-01T06:00:00Z') },
      NOW,
    );
    expect(w).toMatchObject({
      status: 'active',
      startsOn: '2026-10-01',
      endsOn: '2027-01-01',
      firstPaidOn: '2026-06-01',
      startSetByAdmin: true,
    });
  });

  it('lets an admin set the end outright', () => {
    const w = resolveCommissionWaiver(
      { ...base, endsOn: '2027-03-31', firstPaidAt: new Date('2026-10-01T06:00:00Z') },
      NOW,
    );
    expect(w).toMatchObject({ status: 'active', startsOn: '2026-10-01', endsOn: '2027-03-31', endSetByAdmin: true });
  });

  it('has not started while an admin-set start is in the future', () => {
    const w = resolveCommissionWaiver({ ...base, startsOn: '2026-11-01' }, NOW);
    expect(w).toMatchObject({ status: 'not_started', startsOn: '2026-11-01', endsOn: '2027-02-01' });
  });

  it('passes the agreed after-period rate through', () => {
    expect(resolveCommissionWaiver({ ...base, afterWaiverBps: 500 }, NOW).afterWaiverBps).toBe(500);
  });
});

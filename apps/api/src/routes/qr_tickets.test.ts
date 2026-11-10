import { describe, expect, it } from 'vitest';
import { qrScanSubjectOf, qrValidateBodySchema } from './qr_tickets.js';

const uuid = '018f6e2a-7c3b-7d4e-9a1b-2c3d4e5f6a7b';

/**
 * The validate body takes exactly one subject. Pure schema checks — the
 * door-scan state machine itself is covered in
 * `services/qr_ticket_service.test.ts`.
 */
describe('qr-tickets/validate body', () => {
  it('accepts a code alone (the scan / typed-code path, unchanged)', () => {
    const parsed = qrValidateBodySchema.parse({ code: 'abc', consume: false });
    expect(qrScanSubjectOf(parsed)).toEqual({ code: 'abc' });
    expect(parsed.consume).toBe(false);
  });

  it('accepts a bookingId or a userMembershipId alone (the desk lookup by name)', () => {
    expect(qrScanSubjectOf(qrValidateBodySchema.parse({ bookingId: uuid }))).toEqual({
      bookingId: uuid,
    });
    expect(qrScanSubjectOf(qrValidateBodySchema.parse({ userMembershipId: uuid }))).toEqual({
      userMembershipId: uuid,
    });
  });

  it('rejects no subject, two subjects, and a non-uuid id', () => {
    expect(qrValidateBodySchema.safeParse({ consume: true }).success).toBe(false);
    expect(qrValidateBodySchema.safeParse({ code: 'abc', bookingId: uuid }).success).toBe(false);
    expect(qrValidateBodySchema.safeParse({ bookingId: 'not-a-uuid' }).success).toBe(false);
  });
});

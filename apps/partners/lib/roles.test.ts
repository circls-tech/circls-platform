import { describe, expect, it } from 'vitest';
import type { TenantRole } from '@/lib/api/types';
import { ROLE_ORDER, roleCan } from './roles';

describe('roleCan', () => {
  it('mirrors the grants in PARTNER_CAPS', () => {
    // owner, manager, staff, readonly
    expect(ROLE_ORDER.map((r) => roleCan(r, 'bookings.cancel'))).toEqual([true, true, true, false]);
  });

  it('grants nothing without a role it knows', () => {
    expect(roleCan(null, 'bookings.cancel')).toBe(false);
    expect(roleCan(undefined, 'bookings.cancel')).toBe(false);
    expect(roleCan('auditor' as TenantRole, 'bookings.cancel')).toBe(false);
  });
});

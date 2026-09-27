import { describe, expect, it } from 'vitest';
import type { TenantRole } from '@/lib/api/types';
import { ROLE_ORDER, roleCan, roleCanActOn } from './roles';

describe('roleCan', () => {
  it('mirrors the grants in PARTNER_CAPS', () => {
    // owner, manager, staff, readonly
    expect(ROLE_ORDER.map((r) => roleCan(r, 'bookings.create'))).toEqual([true, true, true, false]);
    expect(ROLE_ORDER.map((r) => roleCan(r, 'bookings.cancel'))).toEqual([true, true, true, false]);
    for (const cap of ['events.write', 'pricing.write', 'members.role_change', 'integration.api_keys.manage'] as const) {
      expect(ROLE_ORDER.map((r) => roleCan(r, cap))).toEqual([true, true, false, false]);
    }
  });

  it('grants nothing without a role it knows', () => {
    expect(roleCan(null, 'bookings.cancel')).toBe(false);
    expect(roleCan(undefined, 'bookings.cancel')).toBe(false);
    expect(roleCan('auditor' as TenantRole, 'bookings.cancel')).toBe(false);
  });
});

describe('roleCanActOn', () => {
  it('reaches up to your own role and no further', () => {
    expect(ROLE_ORDER.map((r) => roleCanActOn('manager', r))).toEqual([false, true, true, true]);
    expect(ROLE_ORDER.map((r) => roleCanActOn('owner', r))).toEqual([true, true, true, true]);
  });

  it('reaches nothing without a role it knows', () => {
    expect(roleCanActOn(null, 'readonly')).toBe(false);
    expect(roleCanActOn('auditor' as TenantRole, 'readonly')).toBe(false);
  });
});

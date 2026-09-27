import { describe, expect, it } from 'vitest';
import type { TenantRole } from '@/lib/api/types';
import { ROLE_ORDER, roleCan, roleCanActOn, tenantCan } from './roles';

describe('roleCan', () => {
  it('mirrors the grants in PARTNER_CAPS', () => {
    // owner, manager, staff, readonly
    expect(ROLE_ORDER.map((r) => roleCan(r, 'bookings.create'))).toEqual([true, true, true, false]);
    expect(ROLE_ORDER.map((r) => roleCan(r, 'bookings.cancel'))).toEqual([true, true, true, false]);
    expect(ROLE_ORDER.map((r) => roleCan(r, 'questions.write'))).toEqual([true, true, true, false]);
    for (const cap of [
      'events.write',
      'pricing.write',
      'discounts.write',
      'tenant.update',
      'members.role_change',
      'integration.read',
      'integration.api_keys.manage',
    ] as const) {
      expect(ROLE_ORDER.map((r) => roleCan(r, cap))).toEqual([true, true, false, false]);
    }
  });

  it('mirrors PLATFORM_CAPS for the Circls organisation', () => {
    const platform = { isPlatform: true };
    expect(ROLE_ORDER.map((r) => roleCan(r, 'events.write', platform))).toEqual([true, false, false, false]);
    expect(ROLE_ORDER.map((r) => roleCan(r, 'members.invite', platform))).toEqual([true, false, false, false]);
    expect(ROLE_ORDER.map((r) => roleCan(r, 'bookings.cancel', platform))).toEqual([true, false, false, false]);
    expect(ROLE_ORDER.map((r) => roleCan(r, 'integration.read', platform))).toEqual([true, true, false, false]);
  });

  it('grants nothing without a role it knows', () => {
    expect(roleCan(null, 'bookings.cancel')).toBe(false);
    expect(roleCan(undefined, 'bookings.cancel')).toBe(false);
    expect(roleCan('auditor' as TenantRole, 'bookings.cancel')).toBe(false);
  });
});

describe('tenantCan', () => {
  const tenant = (myRole: TenantRole, status = 'active', isPlatform = false) => ({ myRole, status, isPlatform });

  it('follows the role on an active organisation', () => {
    expect(tenantCan(tenant('staff'), 'bookings.cancel')).toBe(true);
    expect(tenantCan(tenant('staff'), 'events.write')).toBe(false);
  });

  it('keeps only reading while the organisation is suspended', () => {
    expect(tenantCan(tenant('owner', 'suspended'), 'integration.read')).toBe(true);
    expect(tenantCan(tenant('owner', 'suspended'), 'integration.api_keys.manage')).toBe(false);
    expect(tenantCan(tenant('staff', 'suspended'), 'bookings.cancel')).toBe(false);
  });

  it('grants nothing for an organisation you are not in', () => {
    expect(tenantCan(undefined, 'integration.read')).toBe(false);
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

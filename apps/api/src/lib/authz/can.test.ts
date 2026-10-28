import { describe, expect, it } from 'vitest';
import type { TenantRole } from '../../db/schema/tenant_members.js';
import { ALL_CAPABILITIES } from './capabilities.js';
import { can, isSuspendedTenant } from './can.js';

const ROLES: TenantRole[] = ['owner', 'manager', 'staff', 'readonly'];

/**
 * Snapshot the entire (role × capability) decision matrix for both partner
 * and platform tenants. Adding a new Capability forces every role row to be
 * updated; forgetting to grant it defaults to false (default-deny).
 */
describe('can() — authz matrix', () => {
  it('partner-tenant matrix is stable', () => {
    const matrix: Record<string, Record<string, boolean>> = {};
    for (const role of ROLES) {
      matrix[role] = {};
      for (const cap of ALL_CAPABILITIES) {
        matrix[role]![cap] = can({ role, isPlatform: false, suspended: false }, cap);
      }
    }
    expect(matrix).toMatchSnapshot();
  });

  it('platform-tenant matrix is stable', () => {
    const matrix: Record<string, Record<string, boolean>> = {};
    for (const role of ROLES) {
      matrix[role] = {};
      for (const cap of ALL_CAPABILITIES) {
        matrix[role]![cap] = can({ role, isPlatform: true, suspended: false }, cap);
      }
    }
    expect(matrix).toMatchSnapshot();
  });

  it('owner of a partner tenant can write venues', () => {
    expect(can({ role: 'owner', isPlatform: false, suspended: false }, 'venues.write')).toBe(true);
  });

  it('staff of a partner tenant cannot write venues', () => {
    expect(can({ role: 'staff', isPlatform: false, suspended: false }, 'venues.write')).toBe(false);
  });

  it('manager of a platform tenant can execute payouts', () => {
    expect(can({ role: 'manager', isPlatform: true, suspended: false }, 'admin.payouts.execute')).toBe(true);
  });

  it('staff of a platform tenant cannot execute payouts', () => {
    expect(can({ role: 'staff', isPlatform: true, suspended: false }, 'admin.payouts.execute')).toBe(false);
  });

  it('partner-tenant member never has admin.* caps', () => {
    for (const role of ROLES) {
      expect(can({ role, isPlatform: false, suspended: false }, 'admin.payouts.execute')).toBe(false);
      expect(can({ role, isPlatform: false, suspended: false }, 'admin.tenants.suspend')).toBe(false);
    }
  });

  it('a suspended tenant keeps only the read capabilities', () => {
    const owner = { role: 'owner' as const, isPlatform: false, suspended: true };
    expect(can(owner, 'venues.read')).toBe(true);
    expect(can(owner, 'integration.read')).toBe(true);
    expect(can(owner, 'venues.write')).toBe(false);
    expect(can(owner, 'questions.write')).toBe(false);
  });

  it("a super admin in a partner org holds a Manager's caps, bar the team, API keys, Earnings and settings", () => {
    const visit = { role: 'manager' as const, isPlatform: false, suspended: false, superAdmin: true };
    const granted = ALL_CAPABILITIES.filter((cap) => can(visit, cap));
    expect(granted).toEqual([
      'tenant.read',
      'members.read',
      'venues.read', 'venues.write',
      'arenas.read', 'arenas.write',
      'schedules.read', 'schedules.write',
      'pricing.read', 'pricing.write',
      'bookings.read', 'bookings.create', 'bookings.cancel',
      'analytics.read',
      'payments.refund',
      'events.read', 'events.write',
      'memberships.read', 'memberships.write',
      'discounts.read', 'discounts.write',
      'questions.read', 'questions.write',
      'integration.read',
    ]);
  });

  it('a super admin context grants nothing on the platform tenant, and only reads when suspended', () => {
    const onPlatform = { role: 'manager' as const, isPlatform: true, suspended: false, superAdmin: true };
    expect(ALL_CAPABILITIES.filter((cap) => can(onPlatform, cap))).toEqual([]);
    const suspended = { role: 'manager' as const, isPlatform: false, suspended: true, superAdmin: true };
    expect(can(suspended, 'events.read')).toBe(true);
    expect(can(suspended, 'events.write')).toBe(false);
  });

  it('only a partner tenant can be suspended', () => {
    expect(isSuspendedTenant({ isPlatform: false, status: 'suspended' })).toBe(true);
    expect(isSuspendedTenant({ isPlatform: false, status: 'active' })).toBe(false);
    expect(isSuspendedTenant({ isPlatform: true, status: 'suspended' })).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import type { TenantRole } from '../../db/schema/tenant_members.js';
import { ALL_CAPABILITIES } from './capabilities.js';
import { can } from './can.js';

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
        matrix[role]![cap] = can({ role, isPlatform: false }, cap);
      }
    }
    expect(matrix).toMatchSnapshot();
  });

  it('platform-tenant matrix is stable', () => {
    const matrix: Record<string, Record<string, boolean>> = {};
    for (const role of ROLES) {
      matrix[role] = {};
      for (const cap of ALL_CAPABILITIES) {
        matrix[role]![cap] = can({ role, isPlatform: true }, cap);
      }
    }
    expect(matrix).toMatchSnapshot();
  });

  it('owner of a partner tenant can write venues', () => {
    expect(can({ role: 'owner', isPlatform: false }, 'venues.write')).toBe(true);
  });

  it('staff of a partner tenant cannot write venues', () => {
    expect(can({ role: 'staff', isPlatform: false }, 'venues.write')).toBe(false);
  });

  it('manager of a platform tenant can execute payouts', () => {
    expect(can({ role: 'manager', isPlatform: true }, 'admin.payouts.execute')).toBe(true);
  });

  it('staff of a platform tenant cannot execute payouts', () => {
    expect(can({ role: 'staff', isPlatform: true }, 'admin.payouts.execute')).toBe(false);
  });

  it('partner-tenant member never has admin.* caps', () => {
    for (const role of ROLES) {
      expect(can({ role, isPlatform: false }, 'admin.payouts.execute')).toBe(false);
      expect(can({ role, isPlatform: false }, 'admin.tenants.suspend')).toBe(false);
    }
  });
});

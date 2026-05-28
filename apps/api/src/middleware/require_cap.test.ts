import { describe, expect, it } from 'vitest';
import { Forbidden } from '../lib/errors.js';
import type { TenantContext } from './tenant_context.js';
import { assertCap } from './require_cap.js';

function ctx(overrides: Partial<TenantContext> = {}): TenantContext {
  return {
    tenantId: '00000000-0000-0000-0000-000000000000',
    userId: '00000000-0000-0000-0000-000000000001',
    role: 'owner',
    isPlatform: false,
    ...overrides,
  };
}

describe('assertCap()', () => {
  it('allows owner to write venues', () => {
    expect(() => assertCap(ctx({ role: 'owner' }), 'venues.write')).not.toThrow();
  });

  it('throws Forbidden when staff tries to write venues', () => {
    expect(() => assertCap(ctx({ role: 'staff' }), 'venues.write')).toThrow(Forbidden);
  });

  it('error code is forbidden_capability and includes the missing cap', () => {
    try {
      assertCap(ctx({ role: 'staff' }), 'venues.write');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(Forbidden);
      const f = err as Forbidden;
      expect(f.code).toBe('forbidden_capability');
      expect(f.details).toEqual({ cap: 'venues.write' });
    }
  });

  it('Circls staff can review listings; partner staff cannot', () => {
    expect(() => assertCap(ctx({ role: 'staff', isPlatform: true }), 'admin.listings.review')).not.toThrow();
    expect(() => assertCap(ctx({ role: 'staff', isPlatform: false }), 'admin.listings.review')).toThrow(Forbidden);
  });
});

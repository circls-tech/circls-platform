import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tenant } from '@/lib/api/types';

// The real client pulls in Firebase; only apiFetch and ApiError matter here.
const apiFetch = vi.fn();
class ApiError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
vi.mock('@/lib/api/client', () => ({ apiFetch, ApiError }));

const { readSuperAdminVisit, withSuperAdminVisit, writeSuperAdminVisit } = await import('./super_admin_visit');

/** A Map-backed Storage, so the tests run in the plain node environment. */
function memoryStore(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
  };
}

const org = (id: string, extra: Partial<Tenant> = {}): Tenant => ({
  id,
  name: id,
  slug: id,
  subscriptionStatus: 'trial',
  status: 'active',
  ...extra,
});
const circls = org('circls', { isPlatform: true, myRole: 'owner', mySuperAdmin: true });
const visit = org('partner', { myRole: 'manager', superAdminVisit: true });

describe('withSuperAdminVisit', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', memoryStore());
    apiFetch.mockReset();
  });

  it('adds the open org to a super admin’s own', async () => {
    writeSuperAdminVisit('u1', 'partner');
    apiFetch.mockResolvedValue(visit);
    expect(await withSuperAdminVisit([circls], 'u1', undefined)).toEqual([circls, visit]);
  });

  it('drops the visit when the API refuses it', async () => {
    writeSuperAdminVisit('u1', 'partner');
    apiFetch.mockRejectedValue(new ApiError('super_admin_required'));
    expect(await withSuperAdminVisit([circls], 'u1', [circls, visit])).toEqual([circls]);
    expect(readSuperAdminVisit('u1')).toBeNull();
  });

  it('keeps the org it already had when the API is briefly unreachable', async () => {
    writeSuperAdminVisit('u1', 'partner');
    apiFetch.mockRejectedValue(new TypeError('Failed to fetch'));
    expect(await withSuperAdminVisit([circls], 'u1', [circls, visit])).toEqual([circls, visit]);
    expect(readSuperAdminVisit('u1')).toBe('partner');
  });

  it('opens nothing for someone who is no longer a super admin', async () => {
    writeSuperAdminVisit('u1', 'partner');
    const plain = { ...circls, mySuperAdmin: false };
    expect(await withSuperAdminVisit([plain], 'u1', undefined)).toEqual([plain]);
    expect(apiFetch).not.toHaveBeenCalled();
    expect(readSuperAdminVisit('u1')).toBeNull();
  });
});

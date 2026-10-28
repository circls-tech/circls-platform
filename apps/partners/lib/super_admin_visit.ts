import { ApiError, apiFetch } from '@/lib/api/client';
import type { Tenant } from '@/lib/api/types';
import { isSuperAdmin } from '@/lib/roles';

/**
 * The partner org a Circls super admin has open, kept per signed-in user so
 * it survives a reload and another person's sign-in never inherits it. One
 * at a time: opening another replaces it.
 */
const keyFor = (uid: string) => `circls.superAdminVisit.${uid}`;

/** The API's answers that mean the visit is over, not just failed this time. */
const VISIT_REFUSALS = ['super_admin_required', 'circls_support_not_granted', 'tenant_not_found', 'bad_request'];

export function readSuperAdminVisit(uid: string): string | null {
  try {
    return localStorage.getItem(keyFor(uid));
  } catch {
    return null;
  }
}

export function writeSuperAdminVisit(uid: string, tenantId: string): void {
  try {
    localStorage.setItem(keyFor(uid), tenantId);
  } catch {
    // Storage unavailable: the visit lasts until the next reload.
  }
}

export function clearSuperAdminVisit(uid: string): void {
  try {
    localStorage.removeItem(keyFor(uid));
  } catch {
    // Nothing stored.
  }
}

/**
 * The user's own orgs plus the one they have open as a super admin, if any.
 * Loading it records the visit on that org's audit log (the API skips a
 * repeat within a few hours). A refusal — they're no longer a super admin,
 * the org is gone, or they have since joined it — drops the stored visit.
 * Any other failure (a deploy, a network blip) keeps `cached`, the row the
 * portal already has, so they aren't bounced out of the org mid-work.
 */
export async function withSuperAdminVisit(
  mine: Tenant[],
  uid: string | undefined,
  cached: Tenant[] | undefined,
): Promise<Tenant[]> {
  if (!uid) return mine;
  const visitId = readSuperAdminVisit(uid);
  if (!visitId) return mine;
  if (!isSuperAdmin(mine) || mine.some((t) => t.id === visitId)) {
    clearSuperAdminVisit(uid);
    return mine;
  }
  try {
    const row = await apiFetch<Tenant>(`/v1/super-admin/tenants/${visitId}/visit`, { method: 'POST' });
    return [...mine, row];
  } catch (err) {
    if (err instanceof ApiError && VISIT_REFUSALS.includes(err.code)) {
      clearSuperAdminVisit(uid);
      return mine;
    }
    const previous = cached?.find((t) => t.id === visitId && t.superAdminVisit);
    return previous ? [...mine, previous] : mine;
  }
}

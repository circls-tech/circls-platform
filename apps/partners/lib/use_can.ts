'use client';

import { useMyRole } from '@/lib/api/queries';
import { useOrg } from '@/lib/org_context';
import type { PortalCapability } from '@/lib/roles';

/**
 * Whether the signed-in member may use `cap` in `tenantId` (by default the
 * active organisation) — never while it is suspended. False until their role
 * has loaded, so a gated control appears once it's known rather than
 * flashing and vanishing.
 */
export function useCan(cap: PortalCapability, tenantId?: string | null): boolean {
  const { activeTenantId } = useOrg();
  const { can } = useMyRole(tenantId || activeTenantId);
  return can(cap);
}

'use client';

import { useOrg } from '@/lib/org_context';
import { isSuspended } from '@/lib/roles';
import { SUSPENDED_MESSAGE } from './RoleNotice';

/** Shown on every page while Circls has the active organisation suspended. */
export function SuspendedBanner() {
  const { activeTenantId, tenants } = useOrg();
  if (!isSuspended(tenants.find((t) => t.id === activeTenantId))) return null;
  return (
    <div role="status" className="border-b border-red-200 bg-red-50 px-6 py-2 text-sm text-red-900">
      {SUSPENDED_MESSAGE}
    </div>
  );
}

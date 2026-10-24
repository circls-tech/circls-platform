'use client';

import { useRouter } from 'next/navigation';
import { useSuperAdminVisit } from '@/lib/api/queries';
import { useOrg } from '@/lib/org_context';

/** Shown on every page while a Circls super admin works in an org they opened. */
export function SuperAdminBanner() {
  const router = useRouter();
  const { activeTenantId, tenants } = useOrg();
  const { leave } = useSuperAdminVisit();
  const tenant = tenants.find((t) => t.id === activeTenantId);
  if (!tenant?.superAdminVisit) return null;

  function handleLeave() {
    // The org drops out of the list, so the portal falls back to your own.
    leave();
    router.push('/dashboard');
  }

  return (
    <div
      role="status"
      className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-violet-200 bg-violet-50 px-6 py-2 text-sm text-violet-900"
    >
      <span>
        You&apos;re working in <strong>{tenant.name}</strong> as a Circls super admin. Your visit and
        every change you make show in their audit log.
      </span>
      <button type="button" onClick={handleLeave} className="font-semibold underline hover:no-underline">
        Leave this organisation
      </button>
    </div>
  );
}

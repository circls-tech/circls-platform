'use client';

import { useOrg } from '@/lib/org_context';
import { isSuspended } from '@/lib/roles';
import { Card } from '@/lib/ui';

export const SUSPENDED_MESSAGE =
  'This organisation is suspended, so it can be viewed but not changed. Contact Circls for help.';

/**
 * Stands in for a form or page the signed-in member can't use: `children` says
 * why for their role — unless Circls has the organisation suspended, which is
 * the reason for every role then.
 */
export function RoleNotice({ children }: { children: React.ReactNode }) {
  const { activeTenantId, tenants } = useOrg();
  const suspended = isSuspended(tenants.find((t) => t.id === activeTenantId));
  return (
    <Card>
      <p className="py-2 text-sm text-slate-600">{suspended ? SUSPENDED_MESSAGE : children}</p>
    </Card>
  );
}

'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { AuditLog } from '@/components/audit/AuditLog';

export default function TenantAuditTimelinePage() {
  const { id: tenantId } = useParams<{ id: string }>();
  return (
    <div className="space-y-4">
      <div>
        <Link href={`/tenants/${tenantId}`} className="text-sm text-slate-500 hover:text-slate-800">
          &larr; Tenant
        </Link>
        <h1 className="mt-2 text-2xl font-semibold text-slate-900">Audit timeline</h1>
        <p className="text-sm text-slate-500">Every recorded action for this tenant, newest first.</p>
      </div>
      <AuditLog tenantId={tenantId} />
    </div>
  );
}

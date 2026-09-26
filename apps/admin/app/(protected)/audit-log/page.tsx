import { AuditLog } from '@/components/audit/AuditLog';

export default function AuditLogPage() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Audit log search</h1>
        <p className="text-sm text-slate-500">
          Cross-tenant search of every audit event. Search by organisation,
          person or listing; use the ID fields when you already have one.
        </p>
      </div>
      <AuditLog />
    </div>
  );
}

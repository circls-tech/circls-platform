export default function AuditLogPage() {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Audit log</h1>
      <p className="text-sm text-slate-600">
        Placeholder — Phase 16 wires this to{' '}
        <code>/v1/tenants/:id/audit-log</code> with a global search box (booking
        id / user id / tenant id). The partner-portal Activity log already
        renders the same data scoped to a tenant.
      </p>
    </div>
  );
}

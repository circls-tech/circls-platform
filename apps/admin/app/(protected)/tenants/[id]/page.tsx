'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  useAdminTenantDetail,
  useReactivateTenant,
  useSuspendTenant,
  useTenantAuditLog,
} from '@/lib/api/queries';
import type { AdminTenantDetail, TenantAuditLogItem } from '@/lib/api/types';

const IST_FMT = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});
function fmtIST(iso: string | null | undefined): string {
  if (!iso) return '—';
  return IST_FMT.format(new Date(iso));
}

type Tab = 'overview' | 'members' | 'audit';
const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'members', label: 'Members' },
  { id: 'audit', label: 'Audit timeline' },
];

function StatusPill({ status }: { status: string }) {
  const tone =
    status === 'active'
      ? 'bg-emerald-100 text-emerald-800'
      : status === 'suspended'
        ? 'bg-rose-100 text-rose-800'
        : 'bg-slate-100 text-slate-700';
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}>
      {status}
    </span>
  );
}

function KycPill({ status }: { status: string }) {
  const tone =
    status === 'verified'
      ? 'bg-emerald-100 text-emerald-800'
      : status === 'submitted' || status === 'in_review'
        ? 'bg-amber-100 text-amber-800'
        : status === 'rejected'
          ? 'bg-rose-100 text-rose-800'
          : 'bg-slate-100 text-slate-700';
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}>
      {status}
    </span>
  );
}

export default function TenantDetailPage() {
  const params = useParams<{ id: string }>();
  const tenantId = params.id;
  const [tab, setTab] = useState<Tab>('overview');

  const { data, isLoading, isError, error } = useAdminTenantDetail(tenantId);
  const suspend = useSuspendTenant();
  const reactivate = useReactivateTenant();

  if (isLoading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <span className="block h-6 w-6 animate-spin rounded-full border-2 border-slate-300 border-t-slate-700" />
      </div>
    );
  }
  if (isError || !data) {
    return (
      <div className="space-y-3">
        <Link href="/tenants" className="text-sm text-slate-500 hover:text-slate-800">
          &larr; Tenants
        </Link>
        <p className="text-sm text-red-600">
          Failed to load tenant: {error instanceof Error ? error.message : 'unknown error'}
        </p>
      </div>
    );
  }

  const t = data.tenant;

  return (
    <div className="space-y-6">
      <div>
        <Link href="/tenants" className="text-sm text-slate-500 hover:text-slate-800">
          &larr; Tenants
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold text-slate-900">{t.name}</h1>
          <span className="font-mono text-xs text-slate-500">{t.slug}</span>
          <StatusPill status={t.status} />
          <KycPill status={t.kycStatus} />
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {t.status === 'active' ? (
          <button
            type="button"
            onClick={() => {
              if (!confirm(`Suspend "${t.name}"?`)) return;
              suspend.mutate(t.id);
            }}
            disabled={suspend.isPending}
            className="rounded-md border border-rose-200 bg-rose-50 px-3 py-1.5 text-sm font-medium text-rose-700 hover:bg-rose-100 disabled:opacity-50"
          >
            {suspend.isPending ? 'Suspending…' : 'Suspend tenant'}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => {
              if (!confirm(`Reactivate "${t.name}"?`)) return;
              reactivate.mutate(t.id);
            }}
            disabled={reactivate.isPending}
            className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-sm font-medium text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"
          >
            {reactivate.isPending ? 'Reactivating…' : 'Reactivate tenant'}
          </button>
        )}
        <Link
          href={`/tenants/${t.id}/audit`}
          className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          Full audit timeline
        </Link>
      </div>

      {/* Tabs */}
      <div className="border-b border-slate-200">
        <nav className="-mb-px flex gap-6">
          {TABS.map((tt) => (
            <button
              key={tt.id}
              onClick={() => setTab(tt.id)}
              className={[
                'border-b-2 px-1 pb-2 pt-1 text-sm font-medium transition-colors',
                tab === tt.id
                  ? 'border-slate-900 text-slate-900'
                  : 'border-transparent text-slate-500 hover:text-slate-800',
              ].join(' ')}
              type="button"
            >
              {tt.label}
            </button>
          ))}
        </nav>
      </div>

      {tab === 'overview' && <OverviewTab data={data} />}
      {tab === 'members' && <MembersTab data={data} />}
      {tab === 'audit' && <AuditTab tenantId={t.id} />}
    </div>
  );
}

function OverviewTab({ data }: { data: AdminTenantDetail }) {
  const t = data.tenant;
  const owner = data.members.find((m) => m.role === 'owner') ?? data.members[0];

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Card title="Business">
        <Field label="Legal entity" value={t.legalEntityName} />
        <Field label="GSTIN" value={t.gstin} mono />
        <Field label="PAN" value={t.panNumber} mono />
        <Field label="Subscription" value={t.subscriptionStatus} />
        <Field label="Created" value={fmtIST(t.createdAt)} />
        <Field label="Razorpay Linked Account" value={t.razorpayLinkedAccountId} mono />
      </Card>

      <Card title="Owner contact">
        {owner ? (
          <>
            <Field label="Name" value={owner.displayName} />
            <Field label="Email" value={owner.email} />
            <Field label="Phone" value={owner.phoneE164} mono />
            <Field label="Role" value={owner.role} />
          </>
        ) : (
          <p className="text-sm text-slate-400">No owner on record.</p>
        )}
      </Card>

      <Card title="KYC">
        <Field label="Status" value={t.kycStatus} />
        <Field label="Submitted" value={fmtIST(t.kycSubmittedAt)} />
        <Field label="Verified" value={fmtIST(t.kycVerifiedAt)} />
        {t.kycRejectionReason && (
          <Field label="Rejection reason" value={t.kycRejectionReason} />
        )}
        <KycDocumentsList tenantId={t.id} />
      </Card>

      <Card title="Banking">
        <Field label="Account holder" value={t.bankAccountHolderName} />
        <Field label="Account number" value={t.bankAccountNumber} mono />
        <Field label="IFSC" value={t.bankIfsc} mono />
      </Card>
    </div>
  );
}

function MembersTab({ data }: { data: AdminTenantDetail }) {
  if (data.members.length === 0) {
    return <p className="text-sm text-slate-400">No members on this tenant.</p>;
  }
  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
      <table className="w-full text-sm">
        <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
          <tr>
            <th className="px-4 py-2 font-medium">Name</th>
            <th className="px-4 py-2 font-medium">Email</th>
            <th className="px-4 py-2 font-medium">Phone</th>
            <th className="px-4 py-2 font-medium">Role</th>
            <th className="px-4 py-2 font-medium">Joined</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {data.members.map((m) => (
            <tr key={m.userId}>
              <td className="px-4 py-2.5 text-slate-800">
                {m.displayName ?? <span className="text-slate-400">—</span>}
              </td>
              <td className="px-4 py-2.5 text-slate-700">{m.email ?? '—'}</td>
              <td className="px-4 py-2.5 font-mono text-xs text-slate-600">{m.phoneE164 ?? '—'}</td>
              <td className="px-4 py-2.5 text-slate-700">{m.role}</td>
              <td className="px-4 py-2.5 text-xs text-slate-500">{fmtIST(m.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AuditTab({ tenantId }: { tenantId: string }) {
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading } =
    useTenantAuditLog(tenantId);
  const rows: TenantAuditLogItem[] = data?.pages.flatMap((p) => p.rows) ?? [];

  if (isLoading) {
    return <p className="text-sm text-slate-400">Loading…</p>;
  }
  if (rows.length === 0) {
    return <p className="text-sm text-slate-400">No audit events yet.</p>;
  }
  return (
    <div className="space-y-3">
      <ul className="space-y-2">
        {rows.map((r) => (
          <li
            key={r.id}
            className="flex flex-col gap-1 rounded border border-slate-200 bg-white p-3 text-sm shadow-sm sm:flex-row sm:items-center sm:gap-4"
          >
            <span className="font-mono text-xs text-slate-500 sm:w-44">{fmtIST(r.createdAt)}</span>
            <span className="font-medium text-slate-800">{r.action}</span>
            <span className="text-slate-500">
              {r.entityType}
              {r.entityId && (
                <span className="ml-1 font-mono text-xs text-slate-400">
                  {r.entityId.slice(0, 8)}…
                </span>
              )}
            </span>
            <span className="text-xs text-slate-500 sm:ml-auto">
              {r.actorName ?? r.actorUserId?.slice(0, 8) ?? 'system'}
            </span>
          </li>
        ))}
      </ul>
      {hasNextPage && (
        <div className="flex justify-center">
          <button
            type="button"
            onClick={() => void fetchNextPage()}
            disabled={isFetchingNextPage}
            className="rounded-md border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 disabled:opacity-50"
          >
            {isFetchingNextPage ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * KYC docs: the Phase 11 presign-download endpoint may not exist yet.
 * Render-best-effort: try `/v1/tenants/:id/kyc/documents` and fall back to a
 * "not available" notice. We don't wedge the page on a 404.
 */
function KycDocumentsList({ tenantId }: { tenantId: string }) {
  const [state, setState] = useState<
    | { status: 'idle' }
    | { status: 'loading' }
    | { status: 'unavailable'; reason: string }
    | { status: 'ready'; docs: Array<{ id: string; kind?: string; url?: string }> }
  >({ status: 'idle' });

  // Lazy-fetch on first render
  useEffect(() => {
    let cancel = false;
    setState({ status: 'loading' });
    (async () => {
      try {
        const { apiFetch } = await import('@/lib/api/client');
        const docs = await apiFetch<Array<{ id: string; kind?: string; url?: string }>>(
          `/v1/tenants/${tenantId}/kyc/documents`,
        );
        if (!cancel) setState({ status: 'ready', docs });
      } catch (err) {
        if (cancel) return;
        const msg = err instanceof Error ? err.message : 'unknown error';
        setState({ status: 'unavailable', reason: msg });
      }
    })();
    return () => {
      cancel = true;
    };
  }, [tenantId]);

  if (state.status === 'idle' || state.status === 'loading') {
    return (
      <div className="mt-3 border-t border-slate-100 pt-3">
        <p className="text-xs text-slate-400">Loading documents…</p>
      </div>
    );
  }
  if (state.status === 'unavailable') {
    return (
      <div className="mt-3 border-t border-slate-100 pt-3">
        <p className="text-xs text-slate-400">KYC documents viewer is not available yet (Phase 11).</p>
      </div>
    );
  }
  if (state.docs.length === 0) {
    return (
      <div className="mt-3 border-t border-slate-100 pt-3">
        <p className="text-xs text-slate-400">No KYC documents uploaded.</p>
      </div>
    );
  }
  return (
    <div className="mt-3 border-t border-slate-100 pt-3">
      <p className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">Documents</p>
      <ul className="space-y-1">
        {state.docs.map((d) => (
          <li key={d.id} className="text-xs">
            {d.url ? (
              <a
                href={d.url}
                target="_blank"
                rel="noreferrer"
                className="text-blue-700 hover:underline"
              >
                {d.kind ?? d.id}
              </a>
            ) : (
              <span className="text-slate-600">{d.kind ?? d.id}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

// helpers
function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-slate-500">{title}</h2>
      <dl className="space-y-2 text-sm">{children}</dl>
    </section>
  );
}
function Field({
  label,
  value,
  mono,
}: {
  label: string;
  value: string | null | undefined;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-slate-100 pb-1.5 last:border-b-0 last:pb-0">
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className={`text-right text-slate-800 ${mono ? 'font-mono text-xs' : ''}`}>
        {value && value !== '' ? value : <span className="text-slate-400">—</span>}
      </dd>
    </div>
  );
}


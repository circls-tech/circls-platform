'use client';
import Link from 'next/link';
import { useOrg } from '@/lib/org_context';
import { useVenues } from '@/lib/api/queries';
import { Card } from '@/lib/ui';

function VenueList({ tenantId }: { tenantId: string }) {
  const { data: venues, isLoading } = useVenues(tenantId);

  if (isLoading) {
    return <p className="text-sm text-slate-500">Loading venues…</p>;
  }

  if (!venues || venues.length === 0) {
    return (
      <p className="text-sm text-slate-500">
        No venues yet for this organization. Create one via the API or admin console.
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-3">
      {venues.map((v) => (
        <li key={v.id}>
          <Link
            href={`/venues/${v.id}?tenantId=${tenantId}`}
            className="block rounded-[var(--radius)] border border-[#e5e7eb] bg-white p-4 shadow-sm transition-shadow hover:shadow-md"
          >
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium text-[#0f172a]">{v.name}</p>
                <p className="mt-0.5 text-xs text-slate-400">
                  {v.tzName}
                  {v.lat != null && v.lng != null
                    ? ` · ${v.lat.toFixed(4)}, ${v.lng.toFixed(4)}`
                    : ''}
                </p>
              </div>
              <span
                className={[
                  'rounded-full px-2.5 py-0.5 text-xs font-medium',
                  v.status === 'active'
                    ? 'bg-emerald-50 text-emerald-700'
                    : 'bg-slate-100 text-slate-500',
                ].join(' ')}
              >
                {v.status}
              </span>
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}

export default function VenuesPage() {
  const { activeTenantId, tenants } = useOrg();
  const activeTenant = tenants.find((t) => t.id === activeTenantId);

  if (!activeTenantId) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-xl font-semibold text-[#0f172a]">Venues</h1>
        <Card subtitle="Select or create an organization first to view its venues.">
          <p className="text-sm text-slate-500">
            No active organization. Use the switcher in the top bar to pick one.
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-[#0f172a]">Venues</h1>
        {activeTenant && (
          <p className="mt-0.5 text-sm text-slate-500">{activeTenant.name}</p>
        )}
      </div>
      <VenueList tenantId={activeTenantId} />
    </div>
  );
}

'use client';

import Link from 'next/link';
import { useOrg } from '@/lib/org_context';
import { useMemberships } from '@/lib/api/memberships';
import { useVenues } from '@/lib/api/queries';
import { type CurrencyCode, formatMoney, useVenueCurrencies } from '@/lib/currency';
import type { Membership } from '@/lib/api/types';
import { Button, Card, StatusPill } from '@/lib/ui';

function fmtPrice(pricePaise: number, currency: CurrencyCode) {
  return pricePaise === 0 ? 'Free' : formatMoney(pricePaise, currency, { decimals: 2 });
}

/**
 * One line describing a plan's tiers, e.g. "3 tiers · ₹500–₹2,000".
 *
 * The list used to render every tier as a nested list inside a table cell,
 * which made a row as tall as the plan was complicated. The full tier detail
 * lives on the plan's own page now, where there is room for it.
 */
function tiersSummary(m: Membership, currency: CurrencyCode): string {
  if (m.tiers.length === 0) return '—';
  const prices = m.tiers.map((t) => t.pricePaise);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const count = `${m.tiers.length} tier${m.tiers.length === 1 ? '' : 's'}`;
  const range =
    min === max ? fmtPrice(min, currency) : `${fmtPrice(min, currency)}–${fmtPrice(max, currency)}`;
  return `${count} · ${range}`;
}

export default function MembershipsPage() {
  const { activeTenantId, tenants } = useOrg();
  const activeTenant = tenants.find((t) => t.id === activeTenantId) ?? null;
  const tenantId = activeTenantId ?? '';

  const { data: memberships, isLoading } = useMemberships(tenantId);
  const { data: venues } = useVenues(tenantId);
  const { currencyFor } = useVenueCurrencies();

  function venueName(id: string | null) {
    if (!id) return 'Org-wide';
    return venues?.find((v) => v.id === id)?.name ?? 'Venue';
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-[family-name:var(--font-display)] text-2xl font-extrabold tracking-tight text-[#17151D]">
            Memberships
          </h1>
          {activeTenant && (
            <p className="mt-0.5 text-sm font-semibold text-[#EE5C2B]">{activeTenant.name}</p>
          )}
        </div>
        <Link href="/memberships/new">
          <Button petal="#F9B4D4" size="sm">
            New plan
          </Button>
        </Link>
      </div>

      <Card title="Plans" subtitle="Time-bound passes your customers can buy.">
        {isLoading && <p className="py-2 text-sm text-slate-400">Loading…</p>}
        {!isLoading && memberships?.length === 0 && (
          <p className="py-2 text-sm text-slate-500">
            No plans yet. Use <span className="font-medium">New plan</span> to create one.
          </p>
        )}
        {!isLoading && memberships && memberships.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#e5e7eb] text-left">
                  <th className="pb-2 pr-4 font-medium text-slate-500">Name</th>
                  <th className="pb-2 pr-4 font-medium text-slate-500">Scope</th>
                  <th className="pb-2 pr-4 font-medium text-slate-500">Tiers</th>
                  <th className="pb-2 font-medium text-slate-500">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#f1f5f9]">
                {memberships.map((m) => (
                  <tr key={m.id}>
                    <td className="py-2.5 pr-4 font-medium">
                      {/* The row's only action: everything a plan can do lives
                          on its own page, which has room for it. */}
                      <Link
                        href={`/memberships/${m.id}`}
                        className="text-[#17151D] hover:underline"
                      >
                        {m.name}
                      </Link>
                      {m.description && (
                        <p className="mt-0.5 text-xs font-normal text-slate-400">{m.description}</p>
                      )}
                    </td>
                    <td className="py-2.5 pr-4 text-slate-700">
                      {m.venueId ? (
                        venueName(m.venueId)
                      ) : (
                        <span className="text-slate-500">Org-wide</span>
                      )}
                    </td>
                    <td className="py-2.5 pr-4 whitespace-nowrap text-slate-700">
                      {tiersSummary(m, currencyFor(m.venueId))}
                    </td>
                    <td className="py-2.5">
                      <StatusPill status={m.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

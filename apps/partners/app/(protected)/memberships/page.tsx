'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useOrg } from '@/lib/org_context';
import { useMemberships } from '@/lib/api/memberships';
import { useVenues } from '@/lib/api/queries';
import { useVenueCurrencies } from '@/lib/currency';
import { planSummary } from '@/lib/plan_summary';
import { isMembershipOnShelf } from '@/lib/shelf';
import type { Membership } from '@/lib/api/types';
import { useCan } from '@/lib/use_can';
import { Button, Card, StatusPill } from '@/lib/ui';

/** Same split the Venues and Events pages make: what is selling (or on its
 *  way there) on the default tab, what was withdrawn on the other. */
type PlanShelf = 'active' | 'inactive';

const SHELF_TABS: { key: PlanShelf; label: string }[] = [
  { key: 'active', label: 'Active' },
  { key: 'inactive', label: 'Inactive' },
];

/**
 * One line describing a plan's tiers, e.g. "3 tiers · ₹500–₹2,000".
 *
 * The list used to render every tier as a nested list inside a table cell,
 * which made a row as tall as the plan was complicated. The full tier detail
 * lives on the plan's own page now, where there is room for it.
 */
export default function MembershipsPage() {
  const { activeTenantId, tenants } = useOrg();
  const activeTenant = tenants.find((t) => t.id === activeTenantId) ?? null;
  const tenantId = activeTenantId ?? '';

  const { data: memberships, isLoading } = useMemberships(tenantId);
  const { data: venues } = useVenues(tenantId);
  const { currencyFor } = useVenueCurrencies();
  const canCreate = useCan('memberships.write', tenantId);
  const [shelf, setShelf] = useState<PlanShelf>('active');

  // `isMembershipOnShelf` keeps drafts and pending plans with the active ones:
  // the partner is still working on those. Inactive, rejected and suspended
  // plans sit on the other tab, reachable but out of the way.
  const plans = memberships ?? [];
  const offShelf = plans.filter((m) => !isMembershipOnShelf(m));
  const shown = shelf === 'inactive' ? offShelf : plans.filter(isMembershipOnShelf);
  const counts: Record<PlanShelf, number> = {
    active: plans.length - offShelf.length,
    inactive: offShelf.length,
  };

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
        {canCreate && (
          <Link href="/memberships/new">
            <Button petal="#F9B4D4" size="sm">
              New plan
            </Button>
          </Link>
        )}
      </div>

      <Card title="Plans" subtitle="Time-bound passes your customers can buy.">
        {isLoading && <p className="py-2 text-sm text-slate-400">Loading…</p>}
        {!isLoading && memberships?.length === 0 && (
          <p className="py-2 text-sm text-slate-500">
            No plans yet.
            {canCreate && (
              <>
                {' '}
                Use <span className="font-medium">New plan</span> to create one.
              </>
            )}
          </p>
        )}
        {!isLoading && memberships && memberships.length > 0 && (
          <div className="flex flex-col gap-3">
            <div className="flex gap-1" role="tablist" aria-label="Plan shelf">
              {SHELF_TABS.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  role="tab"
                  aria-selected={shelf === t.key}
                  onClick={() => setShelf(t.key)}
                  className={[
                    'rounded-[var(--radius)] border-2 px-3 py-1 text-sm font-bold transition-colors',
                    shelf === t.key
                      ? 'border-[#17151D] bg-[#F9B4D4] text-[#17151D] shadow-[2px_2px_0_#17151D]'
                      : 'border-transparent text-slate-500 hover:bg-white hover:text-[#17151D]',
                  ].join(' ')}
                >
                  {t.label} <span className="font-normal text-slate-500">({counts[t.key]})</span>
                </button>
              ))}
            </div>

            {shown.length === 0 && (
              <p className="text-sm text-slate-500">
                {shelf === 'inactive'
                  ? 'No inactive plans.'
                  : 'No active plans. Inactive ones are on the other tab.'}
              </p>
            )}

            {shown.length > 0 && (
          <>
            {/* Phones: one card per plan. The four-column table wrapped names
                onto three or four lines, cut Tiers mid-price and pushed Status
                off-screen entirely. Mirrors the members list on a plan page. */}
            <ul className="flex flex-col gap-2 md:hidden">
              {shown.map((m) => (
                <li key={m.id} className="rounded-[var(--radius)] border border-[#e5e7eb] p-3">
                  <div className="flex items-start justify-between gap-2">
                    <Link
                      href={`/memberships/${m.id}`}
                      className="min-w-0 font-medium text-[#17151D] hover:underline"
                    >
                      {m.name}
                    </Link>
                    <StatusPill status={m.status} />
                  </div>
                  {m.description && (
                    <p className="mt-0.5 text-xs text-slate-400">{m.description}</p>
                  )}
                  <dl className="mt-2 flex flex-col gap-0.5 text-xs text-slate-600">
                    <div className="flex justify-between gap-2">
                      <dt className="text-slate-400">Scope</dt>
                      <dd className="text-right">{venueName(m.venueId)}</dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt className="text-slate-400">Tiers</dt>
                      <dd className="text-right">{planSummary(m, currencyFor(m.venueId))}</dd>
                    </div>
                  </dl>
                </li>
              ))}
            </ul>

            {/* Tablet and up: the full table. */}
            <div className="hidden overflow-x-auto md:block">
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
                  {shown.map((m) => (
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
                        {planSummary(m, currencyFor(m.venueId))}
                      </td>
                      <td className="py-2.5">
                        <StatusPill status={m.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}

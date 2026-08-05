'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useOrg } from '@/lib/org_context';
import { useTenantCoupons, useTenantCouponStats, type Coupon } from '@/lib/api/coupons';
import { type CurrencyCode, formatMoney, useVenueCurrencies } from '@/lib/currency';
import { Button, Card, StatusPill } from '@/lib/ui';

function discountLabel(c: Coupon, currency: CurrencyCode): string {
  return c.discountType === 'percent' ? `${c.discountValue / 100}%` : formatMoney(c.discountValue, currency, { decimals: 2 });
}

/** For venue-scoped coupons the scopeId is the venue id; other scopes
 *  (org/arena/event/membership) display in the tenant's currency. */
function couponVenueId(c: Coupon): string | null {
  return c.scopeType === 'venue' ? c.scopeId : null;
}
function scopeLabel(c: Coupon): string {
  return c.scopeType === 'org' ? 'Org-wide' : c.scopeType;
}

export default function CouponsPage() {
  const router = useRouter();
  const { activeTenantId, tenants } = useOrg();
  const activeTenant = tenants.find((t) => t.id === activeTenantId);
  const { data: coupons, isLoading } = useTenantCoupons(activeTenantId ?? '');
  const { data: stats } = useTenantCouponStats(activeTenantId ?? '');
  const { currencyFor, tenantCurrency } = useVenueCurrencies();
  const statByCoupon = new Map((stats?.byCoupon ?? []).map((s) => [s.couponId, s]));

  if (!activeTenantId) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="font-[family-name:var(--font-display)] text-2xl font-extrabold tracking-tight text-[#17151D]">Coupons</h1>
        <Card subtitle="Select or create an organisation first to manage its coupons.">
          <p className="text-sm text-slate-500">No active organisation.</p>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-[family-name:var(--font-display)] text-2xl font-extrabold tracking-tight text-[#17151D]">Coupons</h1>
          {activeTenant && <p className="mt-0.5 text-sm font-semibold text-[#EE5C2B]">{activeTenant.name}</p>}
        </div>
        <Button size="sm" petal="#FFD2A1" onClick={() => router.push('/coupons/new')}>
          Create coupon
        </Button>
      </div>

      {stats && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Card title="Discount you've funded" subtitle="Comes off your settled revenue.">
            <p className="font-[family-name:var(--font-display)] text-2xl font-extrabold tabular-nums text-[#17151D]">
              {formatMoney(stats.orgFunded.discountPaise, tenantCurrency, { decimals: 2 })}
            </p>
          </Card>
          <Card title="Coupon redemptions" subtitle="Times your coupons were used.">
            <p className="font-[family-name:var(--font-display)] text-2xl font-extrabold tabular-nums text-[#17151D]">
              {stats.orgFunded.redemptions}
            </p>
          </Card>
          <Card title="Circls-funded on your sales" subtitle="Funded by Circls — does not affect your payout.">
            <p className="font-[family-name:var(--font-display)] text-2xl font-extrabold tabular-nums text-[#17151D]">
              {formatMoney(stats.platformFunded.discountPaise, tenantCurrency, { decimals: 2 })}
            </p>
          </Card>
        </div>
      )}

      {isLoading && <p className="text-sm text-slate-500">Loading coupons…</p>}
      {!isLoading && (!coupons || coupons.length === 0) && (
        <p className="text-sm text-slate-500">No coupons yet for this organisation.</p>
      )}
      {!isLoading && coupons && coupons.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[#e5e7eb] text-left">
                <th className="pb-2 pr-4 font-medium text-slate-500">Code</th>
                <th className="pb-2 pr-4 font-medium text-slate-500">Scope</th>
                <th className="pb-2 pr-4 font-medium text-slate-500">Discount</th>
                <th className="pb-2 pr-4 font-medium text-slate-500">Visibility</th>
                <th className="pb-2 pr-4 font-medium text-slate-500">Redeemed</th>
                <th className="pb-2 pr-4 font-medium text-slate-500">Discount given</th>
                <th className="pb-2 pr-4 font-medium text-slate-500">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#f1f5f9]">
              {coupons.map((c) => (
                <tr key={c.id}>
                  <td className="py-2.5 pr-4 font-medium">
                    <Link href={`/coupons/${c.id}`} className="font-[family-name:var(--font-display)] font-bold text-[#17151D] hover:underline">{c.code}</Link>
                  </td>
                  <td className="py-2.5 pr-4 text-slate-700">{scopeLabel(c)}</td>
                  <td className="py-2.5 pr-4 text-slate-700">{discountLabel(c, currencyFor(couponVenueId(c)))}</td>
                  <td className="py-2.5 pr-4 capitalize text-slate-700">{c.visibility}</td>
                  <td className="py-2.5 pr-4 text-slate-700">
                    {c.maxRedemptions ? `${c.redeemedCount}/${c.maxRedemptions}` : `${c.redeemedCount}/∞`}
                  </td>
                  <td className="py-2.5 pr-4 tabular-nums text-slate-700">
                    {statByCoupon.has(c.id)
                      ? formatMoney(statByCoupon.get(c.id)!.discountPaise, currencyFor(couponVenueId(c)), { decimals: 2 })
                      : '—'}
                  </td>
                  <td className="py-2.5 pr-4"><StatusPill status={c.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

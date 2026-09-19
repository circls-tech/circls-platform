'use client';

import { useState } from 'react';
import { useAdminPayoutBreakdown } from '@/lib/api/queries';
import type { AdminPayoutBookingLine, AdminPayoutBreakdownLine } from '@/lib/api/types';

/** Minor units → a plain rupee string. Matches the payouts table's format. */
function fmtMinor(minor: number): string {
  return (minor / 100).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

const KIND_LABEL: Record<string, string> = {
  event: 'Event',
  membership: 'Membership',
  venue: 'Venue bookings',
  consumer: 'Customer',
  other: 'Unattributed',
};

function LineTable({
  lines,
  emptyLabel,
  showContact,
}: {
  lines: AdminPayoutBreakdownLine[];
  emptyLabel: string;
  showContact: boolean;
}) {
  if (lines.length === 0) {
    return <p className="px-4 py-6 text-center text-sm text-slate-400">{emptyLabel}</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
          <tr>
            <th className="px-4 py-2 font-medium">{showContact ? 'Customer' : 'What'}</th>
            <th className="px-4 py-2 text-right font-medium">Bookings</th>
            <th className="px-4 py-2 text-right font-medium">Gross</th>
            <th className="px-4 py-2 text-right font-medium">Refunds</th>
            <th className="px-4 py-2 text-right font-medium">Commission</th>
            <th className="px-4 py-2 text-right font-medium">Net</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {lines.map((l) => (
            <tr key={`${l.kind}-${l.id ?? l.label}`}>
              <td className="px-4 py-2.5">
                <span className="font-medium text-slate-800">{l.label}</span>
                <span className="block text-xs text-slate-400">
                  {showContact
                    ? (l.contact ?? 'No contact on file')
                    : [KIND_LABEL[l.kind] ?? l.kind, l.venueName].filter(Boolean).join(' · ')}
                </span>
              </td>
              <td className="px-4 py-2.5 text-right tabular-nums text-slate-600">{l.bookings}</td>
              <td className="px-4 py-2.5 text-right tabular-nums text-slate-700">
                {fmtMinor(l.grossPaise)}
              </td>
              <td className="px-4 py-2.5 text-right tabular-nums text-slate-700">
                {l.refundsPaise === 0 ? '—' : fmtMinor(l.refundsPaise)}
              </td>
              <td className="px-4 py-2.5 text-right tabular-nums text-slate-700">
                {l.commissionPaise === 0 ? '—' : fmtMinor(l.commissionPaise)}
              </td>
              <td className="px-4 py-2.5 text-right font-medium tabular-nums text-slate-900">
                {fmtMinor(l.netPaise)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** "17 Aug" — the payouts table's period format, without the year. */
function fmtDay(iso: string): string {
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

const ITEM_LABEL: Record<string, string> = {
  event: 'Event',
  membership: 'Membership',
  slot: 'Venue booking',
};

/**
 * Who paid, one row per booking.
 *
 * Per booking rather than per customer because the things a partner asks
 * about are per booking: what it was for, which tier, and why a refund
 * shrank the payout. Two refund situations used to be invisible — a refund
 * clawing back a charge paid out in an earlier week (gross 0, refund N), and
 * the gateway fee inside a refund, which the customer gets back but the
 * partner bears. Each is now named on its row.
 */
function BookingTable({
  lines,
  onOpenPayout,
}: {
  lines: AdminPayoutBookingLine[];
  onOpenPayout?: ((payoutId: string) => void) | undefined;
}) {
  if (lines.length === 0) {
    return <p className="px-4 py-6 text-center text-sm text-slate-400">No bookings in this period.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
          <tr>
            <th className="px-4 py-2 font-medium">Customer</th>
            <th className="px-4 py-2 font-medium">What it was for</th>
            <th className="px-4 py-2 font-medium">Tier / court</th>
            <th className="px-4 py-2 text-right font-medium">Gross</th>
            <th className="px-4 py-2 text-right font-medium">Refunds</th>
            <th className="px-4 py-2 text-right font-medium">Commission</th>
            <th className="px-4 py-2 text-right font-medium">Net</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {lines.map((l, i) => (
            <tr key={l.bookingId ?? `unattributed-${i}`} className="align-top">
              <td className="px-4 py-2.5">
                <span className="font-medium text-slate-800">{l.customerName}</span>
                <span className="block text-xs text-slate-400">{l.contact ?? 'No contact on file'}</span>
              </td>
              <td className="px-4 py-2.5">
                <span className="text-slate-800">{l.itemName ?? 'Unattributed'}</span>
                <span className="block text-xs text-slate-400">
                  {[l.itemType ? (ITEM_LABEL[l.itemType] ?? l.itemType) : null, l.venueName]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </td>
              <td className="px-4 py-2.5 text-slate-700">{l.detail ?? '—'}</td>
              <td className="px-4 py-2.5 text-right tabular-nums text-slate-700">
                {fmtMinor(l.grossPaise)}
              </td>
              <td className="px-4 py-2.5 text-right tabular-nums text-slate-700">
                {l.refundsPaise === 0 ? '—' : fmtMinor(l.refundsPaise)}
                {l.refundTiming === 'earlier_payout' && (
                  <span className="block text-xs font-normal text-amber-700">
                    Clawback — paid out{' '}
                    {l.paidInPayout ? (
                      onOpenPayout ? (
                        <button
                          type="button"
                          onClick={() => onOpenPayout(l.paidInPayout!.id)}
                          className="underline hover:text-amber-900"
                        >
                          {fmtDay(l.paidInPayout.periodStart)} → {fmtDay(l.paidInPayout.periodEnd)}
                        </button>
                      ) : (
                        <>
                          {fmtDay(l.paidInPayout.periodStart)} → {fmtDay(l.paidInPayout.periodEnd)}
                        </>
                      )
                    ) : (
                      'in an earlier week'
                    )}
                  </span>
                )}
                {l.refundTiming === 'not_yet_paid' && (
                  <span className="block text-xs font-normal text-slate-500">
                    Refunded before it was paid out
                  </span>
                )}
                {l.refundFeePaise > 0 && (
                  <span className="block text-xs font-normal text-slate-500">
                    incl. {fmtMinor(l.refundFeePaise)} gateway fee
                  </span>
                )}
              </td>
              <td className="px-4 py-2.5 text-right tabular-nums text-slate-700">
                {l.commissionPaise === 0 ? '—' : fmtMinor(l.commissionPaise)}
              </td>
              <td className="px-4 py-2.5 text-right font-medium tabular-nums text-slate-900">
                {fmtMinor(l.netPaise)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * What a payout was actually for, split by item and by customer.
 *
 * The reconciliation line is deliberately prominent: the lines are rebuilt from
 * the payments behind the payout, and if they don't add up to what was paid the
 * admin needs to see that rather than trust a total that quietly disagrees.
 */
export function PayoutBreakdown({
  payoutId,
  onOpenPayout,
}: {
  payoutId: string;
  /** Opens another payout's breakdown — used by clawback lines to jump to
   *  the payout that paid the original charge. */
  onOpenPayout?: (payoutId: string) => void;
}) {
  const [tab, setTab] = useState<'item' | 'consumer'>('item');
  const { data, isLoading, isError, error } = useAdminPayoutBreakdown(payoutId);

  if (isLoading) return <p className="px-4 py-6 text-sm text-slate-400">Loading breakdown…</p>;
  if (isError) {
    return (
      <p className="px-4 py-6 text-sm text-red-600">
        Failed to load: {error instanceof Error ? error.message : 'unknown error'}
      </p>
    );
  }
  if (!data) return null;

  const reconciles = data.unattributedPaise === 0;
  // The two things that make a payout smaller than a partner expects, totted
  // up so the answer to "why is it less?" is on screen before anyone digs.
  const clawbackPaise = data.byBooking
    .filter((l) => l.refundTiming === 'earlier_payout')
    .reduce((sum, l) => sum + l.refundsPaise, 0);
  // Fees on clawback lines are already inside the clawback amount; counting
  // them again would overstate the gap. Only this week's refunds add a fee.
  const feePaise = data.byBooking
    .filter((l) => l.refundTiming !== 'earlier_payout')
    .reduce((sum, l) => sum + l.refundFeePaise, 0);

  return (
    <div className="space-y-3 border-t border-slate-200 bg-slate-50/60 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-1" role="tablist" aria-label="Break the payout down by">
          {(['item', 'consumer'] as const).map((k) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={tab === k}
              onClick={() => setTab(k)}
              className={
                tab === k
                  ? 'rounded-md bg-slate-900 px-3 py-1 text-xs font-medium text-white'
                  : 'rounded-md border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50'
              }
            >
              {k === 'item' ? 'What it was for' : 'Who paid'}
            </button>
          ))}
        </div>
        <p className="text-xs text-slate-500">
          Paid <span className="font-medium tabular-nums text-slate-800">{fmtMinor(data.amountPaise)}</span>
          {' · '}
          attributed{' '}
          <span className="font-medium tabular-nums text-slate-800">
            {fmtMinor(data.attributedPaise)}
          </span>
          {!reconciles && (
            <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 font-medium text-amber-800">
              {fmtMinor(data.unattributedPaise)} unattributed
            </span>
          )}
        </p>
      </div>

      {!reconciles && (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          These lines don&apos;t add up to the amount paid. That is expected when a
          payment has no booking behind it, or when the commission cap applied to
          the week&apos;s total rather than to individual lines.
        </p>
      )}

      {(clawbackPaise > 0 || feePaise > 0) && (
        <p className="rounded-md border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600">
          This payout is reduced by
          {clawbackPaise > 0 && (
            <>
              {' '}
              <span className="font-medium tabular-nums text-slate-800">{fmtMinor(clawbackPaise)}</span>{' '}
              of refunds on bookings paid out in earlier weeks
            </>
          )}
          {clawbackPaise > 0 && feePaise > 0 && ' and'}
          {feePaise > 0 && (
            <>
              {' '}
              <span className="font-medium tabular-nums text-slate-800">{fmtMinor(feePaise)}</span>{' '}
              of gateway fees on this week’s refunds, which partners bear
            </>
          )}
          . See <span className="font-medium">Who paid</span> for each booking.
        </p>
      )}

      <div className="rounded-lg border border-slate-200 bg-white">
        {tab === 'item' ? (
          <LineTable
            lines={data.byItem}
            emptyLabel="Nothing to attribute in this period."
            showContact={false}
          />
        ) : (
          <BookingTable lines={data.byBooking} onOpenPayout={onOpenPayout} />
        )}
      </div>
    </div>
  );
}

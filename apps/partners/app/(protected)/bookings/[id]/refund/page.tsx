'use client';

import { useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { useBookingDetail, useBookingPayments, useCancelBookingWithReason } from '@/lib/api/queries';
import { ApiError } from '@/lib/api/client';
import type { CancelResult } from '@/lib/api/types';
import { formatMoney, useCurrency } from '@/lib/currency';
import { Badge, Button, Card, Input } from '@/lib/ui';
import { useTimezone } from '@/lib/timezone_context';
import { previewRefund } from '@/lib/bookings/refund_preview';

const TIER_COPY: Record<string, { label: string; description: string }> = {
  full: { label: 'Full refund', description: 'More than 24 hours before the slot starts.' },
  partial: { label: '50% refund', description: '2–24 hours before the slot starts.' },
  none: { label: 'No refund', description: 'Less than 2 hours before the slot — out of window.' },
  external: { label: 'No refund', description: 'Cash paid at the venue; refund handled offline.' },
  free: { label: 'No refund', description: 'Free booking — no money was paid.' },
  override: {
    label: 'Full refund (override)',
    description: 'Refunds issued by your team are in full, whatever the timing. Logged in the audit trail.',
  },
  uncaptured: { label: 'No refund', description: 'The payment was never completed — nothing was charged.' },
  unknown: { label: 'Refund depends on timing', description: 'Tiered by how far ahead of the start this is.' },
};

export default function RefundBookingPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { data: booking, isLoading, isError, error } = useBookingDetail(id);
  const { data: paymentsRows } = useBookingPayments(id);
  const cancel = useCancelBookingWithReason();
  const currency = useCurrency({ venueId: booking?.venueId });
  const money = (paise: number) => formatMoney(paise, currency, { decimals: 2 });

  // Slot time display honors the portal-wide viewing tz (Auto = your local time).
  const { resolveTz } = useTimezone();
  const slotFmt = useMemo(
    () =>
      new Intl.DateTimeFormat('en-IN', {
        timeZone: resolveTz(),
        year: 'numeric',
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }),
    [resolveTz],
  );

  const [reason, setReason] = useState('');
  const [result, setResult] = useState<CancelResult | null>(null);

  const firstSlotStart = booking?.slots[0]?.startAt;

  // Pull a charge row for the amount preview; falls back to booking.totalPaise.
  const charge = paymentsRows?.find((p) => p.kind === 'charge');
  const chargeAmount = charge ? Math.max(0, Number(charge.amountPaise)) : (booking?.totalPaise ?? 0);

  // Staff refunding a customer's booking is the server's `bySelf=false` case:
  // a full override refund, whatever the timing.
  const preview = previewRefund({
    paymentMethod: booking?.paymentMethod ?? 'external',
    amountPaise: chargeAmount,
    bySelf: booking?.viewerIsCustomer === true,
    slotStartIso: firstSlotStart,
    chargeStatus: charge?.status,
  });

  const isAlreadyCancelled = booking?.status === 'cancelled';
  const submitting = cancel.isPending;
  const apiError = cancel.error instanceof ApiError ? cancel.error : null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!reason.trim() || submitting || !id) return;
    cancel.mutate(
      { bookingId: id, reason: reason.trim() },
      {
        onSuccess: (data) => setResult(data),
      },
    );
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6">
      <div>
        <div className="flex items-center gap-2 text-sm text-slate-500">
          <Link href={booking ? `/venues/${booking.venueId}/bookings` : '/dashboard'} className="hover:underline">
            Bookings
          </Link>
          <span>/</span>
          <span className="font-medium text-slate-700">Refund</span>
        </div>
        <h1 className="mt-1 font-[family-name:var(--font-display)] text-2xl font-extrabold tracking-tight text-[#17151D]">Refund booking</h1>
      </div>

      {isLoading && (
        <Card>
          <div className="flex items-center gap-2 py-4 text-sm text-slate-500">
            <span className="block h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-slate-600" />
            Loading booking…
          </div>
        </Card>
      )}

      {isError && (
        <Card>
          <p className="py-2 text-sm text-red-600">Failed to load booking: {(error as Error).message}</p>
        </Card>
      )}

      {booking && (
        <>
          {/* Booking summary */}
          <Card>
            <div className="flex flex-col gap-4">
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Customer</p>
                  <p className="mt-0.5 font-medium text-slate-800">{booking.customerName ?? '—'}</p>
                </div>
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Status</p>
                  <p className="mt-0.5"><Badge tone="open" label={booking.status} /></p>
                </div>
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Arena</p>
                  <p className="mt-0.5 text-slate-700">{booking.arenaName}</p>
                </div>
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Payment method</p>
                  <p className="mt-0.5 text-slate-700">{booking.paymentMethod}</p>
                </div>
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Total paid</p>
                  <p className="mt-0.5 font-medium text-slate-800">{money(booking.totalPaise)}</p>
                </div>
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-slate-400">First slot</p>
                  <p className="mt-0.5 text-slate-700">
                    {firstSlotStart ? slotFmt.format(new Date(firstSlotStart)) : '—'}
                  </p>
                </div>
              </div>
            </div>
          </Card>

          {/* Refund preview */}
          {!isAlreadyCancelled && !result && (
            <Card>
              <div className="flex flex-col gap-3">
                <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Refund preview</p>
                <div className="flex items-center justify-between rounded-lg bg-slate-50 px-4 py-3">
                  <div>
                    <p className="text-sm font-medium text-slate-800">
                      {TIER_COPY[preview.tier]?.label ?? preview.tier}
                    </p>
                    <p className="mt-0.5 text-xs text-slate-500">
                      {TIER_COPY[preview.tier]?.description}
                    </p>
                  </div>
                  <p className="text-lg font-semibold text-slate-800">
                    {preview.paise === null ? '—' : money(preview.paise)}
                  </p>
                </div>
                <p className="text-xs text-slate-500">
                  Final refund amount is decided by the server at the moment you submit.
                </p>
              </div>
            </Card>
          )}

          {/* Form */}
          {!isAlreadyCancelled && !result && (
            <Card>
              <form onSubmit={handleSubmit} className="flex flex-col gap-4">
                <Input
                  label="Reason for the refund"
                  placeholder="e.g. Customer requested reschedule"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  required
                />
                {apiError && (
                  <p className="text-sm text-red-600">{apiError.message}</p>
                )}
                <div className="flex justify-end gap-3">
                  <Button type="button" variant="ghost" size="sm" onClick={() => router.back()}>
                    Back
                  </Button>
                  <Button
                    type="submit"
                    variant="danger"
                    size="sm"
                    loading={submitting}
                    disabled={!reason.trim()}
                  >
                    Refund booking
                  </Button>
                </div>
              </form>
            </Card>
          )}

          {isAlreadyCancelled && (
            <Card>
              <p className="py-2 text-sm text-slate-600">This booking is already cancelled.</p>
            </Card>
          )}

          {/* Result */}
          {result && (
            <Card>
              <div className="flex flex-col gap-3">
                <p className="text-sm font-medium text-emerald-700">Booking refunded and cancelled.</p>
                <div className="flex items-center justify-between rounded-lg bg-emerald-50 px-4 py-3">
                  <div>
                    <p className="text-sm font-medium text-slate-800">
                      {TIER_COPY[result.policy]?.label ?? result.policy}
                    </p>
                    {result.refundId && (
                      <p className="mt-0.5 font-mono text-xs text-slate-500">refund: {result.refundId}</p>
                    )}
                  </div>
                  <p className="text-lg font-semibold text-emerald-800">{money(result.refundPaise)}</p>
                </div>
                <div className="flex justify-end">
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => router.push(`/venues/${booking.venueId}/bookings`)}
                  >
                    Back to bookings
                  </Button>
                </div>
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

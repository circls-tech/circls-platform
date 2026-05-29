'use client';

import { useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { useBookingDetail, useBookingPayments, useCancelBookingWithReason } from '@/lib/api/queries';
import { ApiError } from '@/lib/api/client';
import type { CancelResult } from '@/lib/api/types';
import { Badge, Button, Card, Input } from '@/lib/ui';

const IST_FMT = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

function rupees(paise: number): string {
  return `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

/**
 * Pure preview of the refund the engine WILL grant. Mirrors the API-side
 * `computeRefundPolicy` so the partner sees the number before they click.
 * Wholly client-side; the backend is still the source of truth on POST.
 */
function previewRefundPaise(
  slotStartIso: string | undefined,
  paymentMethod: string,
  amountPaise: number,
): { paise: number; tier: 'full' | 'partial' | 'none' | 'external' | 'free' } {
  if (paymentMethod === 'external') return { paise: 0, tier: 'external' };
  if (paymentMethod === 'free' || amountPaise <= 0) return { paise: 0, tier: 'free' };
  if (!slotStartIso) return { paise: 0, tier: 'none' };
  const hours = (new Date(slotStartIso).getTime() - Date.now()) / (60 * 60 * 1000);
  if (hours > 24) return { paise: amountPaise, tier: 'full' };
  if (hours >= 2) return { paise: Math.floor(amountPaise / 2), tier: 'partial' };
  return { paise: 0, tier: 'none' };
}

const TIER_COPY: Record<string, { label: string; description: string }> = {
  full: { label: 'Full refund', description: 'More than 24 hours before the slot starts.' },
  partial: { label: '50% refund', description: '2–24 hours before the slot starts.' },
  none: { label: 'No refund', description: 'Less than 2 hours before the slot — out of window.' },
  external: { label: 'No refund', description: 'Cash paid at the venue; refund handled offline.' },
  free: { label: 'No refund', description: 'Free booking — no money was paid.' },
  override: { label: 'Full refund (override)', description: 'Discretionary refund logged.' },
};

export default function CancelBookingPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { data: booking, isLoading, isError, error } = useBookingDetail(id);
  const { data: paymentsRows } = useBookingPayments(id);
  const cancel = useCancelBookingWithReason();

  const [reason, setReason] = useState('');
  const [result, setResult] = useState<CancelResult | null>(null);

  const firstSlotStart = booking?.slots[0]?.startAt;

  // Pull a charge row for the amount preview; falls back to booking.totalPaise.
  const chargeAmount = useMemo(() => {
    const charge = paymentsRows?.find((p) => p.kind === 'charge');
    if (charge) return Math.max(0, Number(charge.amountPaise));
    return booking?.totalPaise ?? 0;
  }, [paymentsRows, booking?.totalPaise]);

  const preview = previewRefundPaise(firstSlotStart, booking?.paymentMethod ?? 'external', chargeAmount);

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
          <span className="font-medium text-slate-700">Cancel</span>
        </div>
        <h1 className="mt-1 text-xl font-semibold text-slate-800">Cancel booking</h1>
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
                  <p className="mt-0.5 font-medium text-slate-800">{rupees(booking.totalPaise)}</p>
                </div>
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-slate-400">First slot</p>
                  <p className="mt-0.5 text-slate-700">
                    {firstSlotStart ? IST_FMT.format(new Date(firstSlotStart)) : '—'}
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
                  <p className="text-lg font-semibold text-slate-800">{rupees(preview.paise)}</p>
                </div>
                <p className="text-xs text-slate-500">
                  Final refund amount is decided by the server at the moment of cancellation.
                </p>
              </div>
            </Card>
          )}

          {/* Form */}
          {!isAlreadyCancelled && !result && (
            <Card>
              <form onSubmit={handleSubmit} className="flex flex-col gap-4">
                <Input
                  label="Cancellation reason"
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
                    Cancel booking
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
                <p className="text-sm font-medium text-emerald-700">Booking cancelled.</p>
                <div className="flex items-center justify-between rounded-lg bg-emerald-50 px-4 py-3">
                  <div>
                    <p className="text-sm font-medium text-slate-800">
                      {TIER_COPY[result.policy]?.label ?? result.policy}
                    </p>
                    {result.refundId && (
                      <p className="mt-0.5 font-mono text-xs text-slate-500">refund: {result.refundId}</p>
                    )}
                  </div>
                  <p className="text-lg font-semibold text-emerald-800">{rupees(result.refundPaise)}</p>
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

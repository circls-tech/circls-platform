'use client';

import { useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  useBookingDetail,
  useCancelBookingWithReason,
  useMyRole,
  useRefundPreview,
} from '@/lib/api/queries';
import { ApiError } from '@/lib/api/client';
import type { CancelResult } from '@/lib/api/types';
import { refundTierCopy } from '@/lib/bookings/refund_copy';
import { formatMoney, useCurrency } from '@/lib/currency';
import { useOrg } from '@/lib/org_context';
import { RoleNotice } from '@/components/RoleNotice';
import { Badge, Button, Card, Input } from '@/lib/ui';
import { useTimezone } from '@/lib/timezone_context';

export default function RefundBookingPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { data: booking, isLoading, isError, error } = useBookingDetail(id);
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
  const isAlreadyCancelled = booking?.status === 'cancelled';

  // Owners, Managers and Staff can cancel (and so refund); Read-only can't.
  const { activeTenantId } = useOrg();
  const { can, isLoading: roleLoading } = useMyRole(activeTenantId);
  const canCancel = can('bookings.cancel');
  const cancellable = Boolean(booking) && !isAlreadyCancelled && !result;

  // The server works the preview out with the cancel's own rules and inputs
  // (who you are, what was captured, what's already been refunded), so it is
  // what submitting right now would do.
  const preview = useRefundPreview(id, cancellable && canCancel);
  const previewCopy = preview.data ? refundTierCopy(preview.data.tier) : null;
  const previewError =
    preview.error instanceof ApiError ? preview.error.message : preview.error ? 'Something went wrong.' : null;

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
                  <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Total</p>
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

          {cancellable && !roleLoading && !canCancel && (
            <RoleNotice>Your role can&apos;t cancel or refund bookings — Owners, Managers and Staff can.</RoleNotice>
          )}

          {/* Refund preview */}
          {cancellable && canCancel && (
            <Card>
              <div className="flex flex-col gap-3">
                <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Refund preview</p>
                {preview.data && previewCopy ? (
                  <div className="flex items-center justify-between rounded-lg bg-slate-50 px-4 py-3">
                    <div>
                      <p className="text-sm font-medium text-slate-800">{previewCopy.label}</p>
                      <p className="mt-0.5 text-xs text-slate-500">{previewCopy.description}</p>
                    </div>
                    <p className="text-lg font-semibold text-slate-800">{money(preview.data.refundPaise)}</p>
                  </div>
                ) : previewError ? (
                  <p className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-600">
                    Couldn&apos;t work out the refund: {previewError}
                  </p>
                ) : (
                  <div className="flex items-center gap-2 rounded-lg bg-slate-50 px-4 py-3 text-sm text-slate-500">
                    <span className="block h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-slate-600" />
                    Working out the refund…
                  </div>
                )}
                {preview.data && preview.data.alreadyRefundedPaise > 0 && (
                  <p className="text-xs text-slate-500">
                    {money(preview.data.alreadyRefundedPaise)} of the {money(preview.data.amountPaise)} paid was
                    already refunded before now.
                  </p>
                )}
                <p className="text-xs text-slate-500">
                  Final refund amount is decided by the server at the moment you submit.
                </p>
              </div>
            </Card>
          )}

          {/* Form */}
          {cancellable && canCancel && (
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
                    disabled={!reason.trim() || preview.isLoading}
                  >
                    Refund booking
                  </Button>
                </div>
              </form>
            </Card>
          )}

          {/* Also true once our own refund lands and the booking refetches —
              the result card below covers that case. */}
          {isAlreadyCancelled && !result && (
            <Card>
              <p className="py-2 text-sm text-slate-600">This booking is already cancelled.</p>
            </Card>
          )}

          {/* Result */}
          {result && (
            <Card>
              <div className="flex flex-col gap-3">
                <p className="text-sm font-medium text-emerald-700">
                  {result.refundPaise > 0 ? 'Booking refunded and cancelled.' : 'Booking cancelled — nothing was refunded.'}
                </p>
                <div className="flex items-center justify-between rounded-lg bg-emerald-50 px-4 py-3">
                  <div>
                    <p className="text-sm font-medium text-slate-800">{refundTierCopy(result.policy).label}</p>
                    <p className="mt-0.5 text-xs text-slate-500">{refundTierCopy(result.policy).description}</p>
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

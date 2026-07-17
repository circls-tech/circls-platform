'use client';

import { useState } from 'react';
import type { EventBooking, EventTier } from '@/lib/api/types';
import { useCancelBookingWithReason } from '@/lib/api/queries';
import { ApiError } from '@/lib/api/client';
import { type CurrencyCode, currencySymbol, formatMoney } from '@/lib/currency';
import { downloadCsv, toCsv } from '@/lib/csv';
import { Button, Card, StatusPill } from '@/lib/ui';
import { ConfirmDialog } from './ConfirmDialog';

/** Display a UTC instant in the given zone. Mirrors the event pages' `fmt`. */
function fmt(iso: string, tz: string) {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: tz,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

/** "General ×2, VIP ×1" — one entry per ticket line of the booking. */
function ticketsLabel(b: EventBooking, separator = ', '): string {
  return b.tickets.map((t) => `${t.tierName} ×${t.quantity}`).join(separator);
}

function bookingsToCsv(rows: EventBooking[], tz: string, currency: CurrencyCode): string {
  return toCsv(
    ['Booking ID', 'Name', 'Email', 'Phone', 'Tickets', 'Status', `Amount (${currencySymbol(currency)})`, 'Registered At'],
    rows.map((b) => [
      b.id,
      b.customerName ?? '',
      b.customerEmail ?? '',
      b.customerPhone ?? '',
      ticketsLabel(b, '; '),
      b.status,
      (b.totalPaise / 100).toFixed(2),
      fmt(b.createdAt, tz),
    ]),
  );
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'event';
}

interface RegistrationsTableProps {
  title: string;
  emptyLabel: string;
  rows: EventBooking[];
  tz: string;
  currency: CurrencyCode;
  /** Basename for the downloaded file, e.g. `summer-cup-registered`. */
  csvName: string;
  /** Status differs per row only in the registered table; hide it for cancelled. */
  showStatus: boolean;
  /** When set, each row gets a Cancel action (registered table only). */
  onCancel?: (booking: EventBooking) => void;
  /** Booking id currently being cancelled — its button shows a spinner. */
  cancellingId?: string | null;
  children?: React.ReactNode;
}

function RegistrationsTable({
  title,
  emptyLabel,
  rows,
  tz,
  currency,
  csvName,
  showStatus,
  onCancel,
  cancellingId,
  children,
}: RegistrationsTableProps) {
  const hasRows = rows.length > 0;
  return (
    <Card
      title={
        <span className="flex items-center justify-between gap-3">
          <span>
            {title} ({rows.length})
          </span>
          <Button
            variant="secondary"
            size="sm"
            disabled={!hasRows}
            title={hasRows ? `Download ${title.toLowerCase()} as CSV` : 'Nothing to download'}
            onClick={() => downloadCsv(bookingsToCsv(rows, tz, currency), `${csvName}.csv`)}
          >
            Download CSV
          </Button>
        </span>
      }
    >
      {children}
      {!hasRows && <p className="py-6 text-center text-sm text-slate-400">{emptyLabel}</p>}
      {hasRows && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[#e5e7eb] text-left">
                <th className="pb-2 pr-4 font-medium text-slate-500">Name</th>
                <th className="pb-2 pr-4 font-medium text-slate-500">Email</th>
                <th className="pb-2 pr-4 font-medium text-slate-500">Phone</th>
                <th className="pb-2 pr-4 font-medium text-slate-500">Tickets</th>
                {showStatus && <th className="pb-2 pr-4 font-medium text-slate-500">Status</th>}
                <th className="pb-2 pr-4 font-medium text-slate-500">Amount</th>
                <th className="pb-2 font-medium text-slate-500">Registered</th>
                {onCancel && <th className="pb-2" />}
              </tr>
            </thead>
            <tbody className="divide-y divide-[#f1f5f9]">
              {rows.map((b) => (
                <tr key={b.id}>
                  <td className="py-2.5 pr-4 font-medium text-slate-700">
                    {b.customerName ?? <span className="text-slate-400">—</span>}
                  </td>
                  <td className="py-2.5 pr-4 text-slate-700">
                    {b.customerEmail ?? <span className="text-slate-400">—</span>}
                  </td>
                  <td className="py-2.5 pr-4 text-slate-700">
                    {b.customerPhone ?? <span className="text-slate-400">—</span>}
                  </td>
                  <td className="py-2.5 pr-4 text-slate-700">
                    {b.tickets.length > 0 ? (
                      <span className="flex flex-col gap-0.5">
                        {b.tickets.map((t) => (
                          <span key={t.tierName} className="whitespace-nowrap">
                            {t.tierName} ×{t.quantity}
                          </span>
                        ))}
                      </span>
                    ) : (
                      <span className="text-slate-400">—</span>
                    )}
                  </td>
                  {showStatus && (
                    <td className="py-2.5 pr-4">
                      <StatusPill status={b.status} />
                    </td>
                  )}
                  <td className="py-2.5 pr-4 text-slate-700">
                    {b.totalPaise === 0 ? (
                      <span className="text-emerald-600">Free</span>
                    ) : (
                      formatMoney(b.totalPaise, currency, { decimals: 2 })
                    )}
                  </td>
                  <td className="py-2.5 text-slate-700">{fmt(b.createdAt, tz)}</td>
                  {onCancel && (
                    <td className="py-2.5 pl-4 text-right">
                      <Button
                        variant="danger"
                        size="sm"
                        loading={cancellingId === b.id}
                        disabled={cancellingId !== null && cancellingId !== undefined}
                        onClick={() => onCancel(b)}
                      >
                        Cancel
                      </Button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

export interface EventRegistrationsProps {
  bookings: EventBooking[] | undefined;
  isLoading: boolean;
  tiers: EventTier[];
  eventName: string;
  /** Zone registration timestamps are displayed in. */
  tz: string;
  /** Display currency for amounts (see lib/currency). */
  currency: CurrencyCode;
}

/**
 * The registrations section of an event detail page: active registrations and
 * cancellations as two separate tables, each downloadable as CSV.
 */
export function EventRegistrations({
  bookings,
  isLoading,
  tiers,
  eventName,
  tz,
  currency,
}: EventRegistrationsProps) {
  const cancel = useCancelBookingWithReason();
  const [pendingCancel, setPendingCancel] = useState<EventBooking | null>(null);
  const [lastCancelled, setLastCancelled] = useState<{ name: string | null; refundPaise: number } | null>(null);

  if (isLoading) {
    return (
      <Card title="Registrations">
        <p className="py-6 text-center text-sm text-slate-400">Loading…</p>
      </Card>
    );
  }

  const rows = bookings ?? [];
  const registered = rows.filter((b) => b.status !== 'cancelled');
  const cancelled = rows.filter((b) => b.status === 'cancelled');
  const slug = slugify(eventName);

  const cancelError = cancel.error instanceof ApiError ? cancel.error.message : cancel.error ? 'Cancellation failed.' : null;

  function confirmCancel(b: EventBooking) {
    setLastCancelled(null);
    cancel.mutate(
      { bookingId: b.id, reason: 'Cancelled by venue' },
      {
        onSuccess: (data) =>
          setLastCancelled({ name: b.customerName, refundPaise: data.refundPaise }),
      },
    );
  }

  return (
    <>
      <RegistrationsTable
        title="Registered"
        emptyLabel="No registrations yet."
        rows={registered}
        tz={tz}
        currency={currency}
        csvName={`${slug}-registered`}
        showStatus
        onCancel={setPendingCancel}
        cancellingId={cancel.isPending ? cancel.variables?.bookingId ?? null : null}
      >
        {cancelError && (
          <p className="mb-3 rounded-[var(--radius)] bg-red-50 px-3 py-2 text-sm text-red-600">
            {cancelError}
          </p>
        )}
        {lastCancelled && (
          <p className="mb-3 rounded-[var(--radius)] bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
            Cancelled {lastCancelled.name ?? 'registration'}
            {lastCancelled.refundPaise > 0
              ? ` — ${formatMoney(lastCancelled.refundPaise, currency, { decimals: 2 })} refunded.`
              : ' — no refund due.'}
          </p>
        )}
        {tiers.length > 0 && (
          <div className="mb-4 flex flex-col gap-1 rounded-[var(--radius)] border border-[#e5e7eb] bg-slate-50 p-3 text-sm">
            <div className="text-xs font-medium uppercase tracking-wide text-[#475569]">
              Sold by tier
            </div>
            {tiers.map((t) => (
              <div key={t.id} className="flex justify-between text-slate-700">
                <span>{t.name}</span>
                <span>
                  {t.sold} sold{t.capacity != null ? ` / ${t.capacity}` : ''}
                </span>
              </div>
            ))}
          </div>
        )}
      </RegistrationsTable>

      <RegistrationsTable
        title="Cancelled"
        emptyLabel="No cancellations."
        rows={cancelled}
        tz={tz}
        currency={currency}
        csvName={`${slug}-cancelled`}
        showStatus={false}
      />

      <ConfirmDialog
        open={pendingCancel !== null}
        title="Cancel registration"
        message={
          !pendingCancel?.totalPaise
            ? `Cancel ${pendingCancel?.customerName ?? 'this registration'}? The ticket will be revoked. This was a free registration — there is nothing to refund.`
            : pendingCancel.status === 'pending'
              ? `Cancel ${pendingCancel.customerName ?? 'this registration'}? Payment was never completed, so nothing will be refunded.`
              : `Cancel ${pendingCancel.customerName ?? 'this registration'}? The attendee will be refunded ${formatMoney(pendingCancel.totalPaise, currency, { decimals: 2 })} in full and their ticket revoked.`
        }
        confirmLabel="Cancel registration"
        danger
        onConfirm={() => pendingCancel && confirmCancel(pendingCancel)}
        onClose={() => setPendingCancel(null)}
      />
    </>
  );
}

'use client';

import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useArenas, useBookingDetail, useCancelBookingById, useVenueBookings } from '@/lib/api/queries';
import type { BookingListItem, BookingStatus } from '@/lib/api/types';
import { Badge, BadgeTone, Button, Card, Input, Modal } from '@/lib/ui';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useQueryClient } from '@tanstack/react-query';

// ──────────────────────────────────────────────────────────────────────────────
// IST helpers
// ──────────────────────────────────────────────────────────────────────────────

const IST = 'Asia/Kolkata';

/** Format an ISO string to a human-readable date+time in IST. */
function fmtIST(iso: string): string {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: IST,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

/** Format a time portion only. */
function fmtTimeIST(iso: string): string {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: IST,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

/**
 * Returns start/end of "today" in IST as UTC ISO strings:
 * today 00:00 IST → tomorrow 00:00 IST.
 */
function todayISTBounds(): { from: string; to: string } {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: IST,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const todayStr = fmt.format(now); // 'YYYY-MM-DD'
  // Parse local midnight in IST
  const [y, m, d] = todayStr.split('-').map(Number) as [number, number, number];
  const istOffsetMs = 5.5 * 60 * 60 * 1000; // IST = UTC+5:30
  const todayMidnightIST = Date.UTC(y, m - 1, d) - istOffsetMs;
  const tomorrowMidnightIST = todayMidnightIST + 24 * 60 * 60 * 1000;
  return {
    from: new Date(todayMidnightIST).toISOString(),
    to: new Date(tomorrowMidnightIST).toISOString(),
  };
}

type DateFilter = 'today' | 'upcoming' | 'past' | 'custom';

function computeDateBounds(
  filter: DateFilter,
  customFrom: string,
  customTo: string,
): { from: string; to: string } {
  const now = new Date();
  const istOffsetMs = 5.5 * 60 * 60 * 1000;
  switch (filter) {
    case 'today':
      return todayISTBounds();
    case 'upcoming': {
      const in60d = new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000);
      return { from: now.toISOString(), to: in60d.toISOString() };
    }
    case 'past': {
      const ago60d = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);
      return { from: ago60d.toISOString(), to: now.toISOString() };
    }
    case 'custom': {
      // customFrom/customTo are 'YYYY-MM-DD' local calendar dates interpreted as IST day bounds
      if (!customFrom || !customTo) return todayISTBounds();
      const [fy, fm, fd] = customFrom.split('-').map(Number) as [number, number, number];
      const [ty, tm, td] = customTo.split('-').map(Number) as [number, number, number];
      const fromMs = Date.UTC(fy, fm - 1, fd) - istOffsetMs;
      const toMs = Date.UTC(ty, tm - 1, td) - istOffsetMs + 24 * 60 * 60 * 1000;
      return {
        from: new Date(fromMs).toISOString(),
        to: new Date(toMs).toISOString(),
      };
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Status badge mapping
// ──────────────────────────────────────────────────────────────────────────────

function statusTone(status: BookingStatus): BadgeTone {
  switch (status) {
    case 'confirmed': return 'success';
    case 'pending': return 'warning';
    case 'cancelled': return 'blocked';
    case 'completed': return 'booked';
    case 'no_show': return 'held';
  }
}

const STATUS_OPTIONS: { value: BookingStatus | ''; label: string }[] = [
  { value: '', label: 'All statuses' },
  { value: 'pending', label: 'Pending' },
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'completed', label: 'Completed' },
  { value: 'no_show', label: 'No show' },
];

// ──────────────────────────────────────────────────────────────────────────────
// Booking detail modal
// ──────────────────────────────────────────────────────────────────────────────

interface BookingDetailModalProps {
  bookingId: string | null;
  venueId: string;
  onClose: () => void;
}

function BookingDetailModal({ bookingId, venueId, onClose }: BookingDetailModalProps) {
  const qc = useQueryClient();
  const { data: detail, isLoading, isError } = useBookingDetail(bookingId);
  const cancel = useCancelBookingById('');
  const [confirmOpen, setConfirmOpen] = useState(false);

  const handleCancel = useCallback(() => {
    if (!bookingId) return;
    cancel.mutate(bookingId, {
      onSuccess: () => {
        void qc.invalidateQueries({ queryKey: ['venue-bookings', venueId] });
        void qc.invalidateQueries({ queryKey: ['slots'] });
        setConfirmOpen(false);
        onClose();
      },
    });
  }, [bookingId, cancel, qc, venueId, onClose]);

  const isCancellable = detail && detail.status !== 'cancelled';

  return (
    <>
      <Modal open={Boolean(bookingId)} onClose={onClose} title="Booking detail" maxWidth="max-w-xl">
        {isLoading && (
          <div className="flex items-center gap-2 py-8 text-sm text-slate-500">
            <span className="block h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-slate-600" />
            Loading…
          </div>
        )}
        {isError && (
          <p className="py-4 text-sm text-red-600">Failed to load booking details.</p>
        )}
        {detail && (
          <div className="flex flex-col gap-5">
            {/* Customer info */}
            <div className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Customer</p>
                <p className="mt-0.5 font-medium text-slate-800">{detail.customerName ?? '—'}</p>
              </div>
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Contact</p>
                <p className="mt-0.5 text-slate-700">{detail.customerContact ?? '—'}</p>
              </div>
              {detail.note && (
                <div className="col-span-2">
                  <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Note</p>
                  <p className="mt-0.5 text-slate-700">{detail.note}</p>
                </div>
              )}
            </div>

            {/* Booking info */}
            <div className="grid grid-cols-2 gap-x-6 gap-y-3 rounded-lg bg-slate-50 p-4 text-sm">
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Arena</p>
                <p className="mt-0.5 text-slate-700">{detail.arenaName}</p>
              </div>
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Status</p>
                <div className="mt-0.5">
                  <Badge tone={statusTone(detail.status)} label={detail.status} />
                </div>
              </div>
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Total</p>
                <p className="mt-0.5 font-medium text-slate-800">₹{(detail.totalPaise / 100).toFixed(0)}</p>
              </div>
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Booked at</p>
                <p className="mt-0.5 text-slate-700">{fmtIST(detail.createdAt)}</p>
              </div>
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Channel</p>
                <p className="mt-0.5 text-slate-700">{detail.channel}</p>
              </div>
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Payment</p>
                <p className="mt-0.5 text-slate-700">{detail.paymentMethod}</p>
              </div>
            </div>

            {/* Slots */}
            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400">
                Slots ({detail.slots.length})
              </p>
              <div className="flex flex-col gap-1.5">
                {detail.slots.map((slot) => (
                  <div
                    key={slot.id}
                    className="flex items-center justify-between rounded-md border border-slate-100 bg-white px-3 py-2 text-sm"
                  >
                    <span className="text-slate-700">
                      {fmtIST(slot.startAt)} – {fmtTimeIST(slot.endAt)}
                    </span>
                    <span className="font-medium text-slate-800">₹{(slot.pricePaise / 100).toFixed(0)}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Actions */}
            {isCancellable && (
              <div className="flex justify-end border-t border-slate-100 pt-4">
                <Button
                  variant="danger"
                  size="sm"
                  loading={cancel.isPending}
                  onClick={() => setConfirmOpen(true)}
                >
                  Cancel booking
                </Button>
              </div>
            )}
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={confirmOpen}
        title="Cancel booking?"
        message="This frees the slot(s) and cannot be undone."
        confirmLabel="Cancel booking"
        danger
        onConfirm={handleCancel}
        onClose={() => setConfirmOpen(false)}
      />
    </>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Debounce hook
// ──────────────────────────────────────────────────────────────────────────────

function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(id);
  }, [value, delay]);
  return debounced;
}

// ──────────────────────────────────────────────────────────────────────────────
// Main page
// ──────────────────────────────────────────────────────────────────────────────

export default function BookingsPage() {
  const { venueId } = useParams<{ venueId: string }>();
  const tenantId = useSearchParams().get('tenantId') ?? '';

  // ── Filters ──
  const [searchInput, setSearchInput] = useState('');
  const q = useDebounced(searchInput, 300);
  const [dateFilter, setDateFilter] = useState<DateFilter>('today');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [arenaFilter, setArenaFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<BookingStatus | ''>('');

  // ── Selected booking for detail ──
  const [selectedBookingId, setSelectedBookingId] = useState<string | null>(null);

  // ── Date bounds ──
  const { from, to } = useMemo(
    () => computeDateBounds(dateFilter, customFrom, customTo),
    [dateFilter, customFrom, customTo],
  );

  // ── Queries ──
  const { data: arenas } = useArenas(venueId);
  const {
    data: bookings,
    isLoading,
    isError,
    error,
  } = useVenueBookings(venueId, {
    from,
    to,
    arenaId: arenaFilter || undefined,
    status: statusFilter || undefined,
    q: q || undefined,
  });

  const DATE_TOGGLES: { key: DateFilter; label: string }[] = [
    { key: 'today', label: 'Today' },
    { key: 'upcoming', label: 'Upcoming' },
    { key: 'past', label: 'Past' },
    { key: 'custom', label: 'Custom' },
  ];

  return (
    <div className="flex flex-col gap-6">
      {/* ── Header ── */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <Link
              href={`/venues/${venueId}${tenantId ? `?tenantId=${tenantId}` : ''}`}
              className="hover:underline"
            >
              Venue
            </Link>
            <span>/</span>
            <span className="font-medium text-slate-700">Bookings</span>
          </div>
          <h1 className="mt-1 text-xl font-semibold text-slate-800">Bookings</h1>
        </div>
      </div>

      {/* ── Filters ── */}
      <Card>
        <div className="flex flex-col gap-4">
          {/* Search */}
          <Input
            label="Search"
            placeholder="Customer name or contact…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />

          {/* Date filter toggles */}
          <div className="flex flex-col gap-2">
            <p className="text-xs font-medium text-slate-500">Date range</p>
            <div className="flex flex-wrap gap-2">
              {DATE_TOGGLES.map(({ key, label }) => (
                <button
                  key={key}
                  onClick={() => setDateFilter(key)}
                  className={[
                    'rounded-md border px-3 py-1.5 text-xs font-medium transition-colors',
                    dateFilter === key
                      ? 'border-brand-600 bg-brand-600 text-white'
                      : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50',
                  ].join(' ')}
                >
                  {label}
                </button>
              ))}
            </div>
            {dateFilter === 'custom' && (
              <div className="flex flex-wrap items-end gap-3">
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-slate-500">From</label>
                  <input
                    type="date"
                    value={customFrom}
                    onChange={(e) => setCustomFrom(e.target.value)}
                    className="rounded-md border border-slate-200 px-3 py-1.5 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-brand-500"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-slate-500">To</label>
                  <input
                    type="date"
                    value={customTo}
                    onChange={(e) => setCustomTo(e.target.value)}
                    className="rounded-md border border-slate-200 px-3 py-1.5 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-brand-500"
                  />
                </div>
              </div>
            )}
          </div>

          {/* Arena + status filters */}
          <div className="flex flex-wrap gap-3">
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-slate-500">Arena</label>
              <select
                value={arenaFilter}
                onChange={(e) => setArenaFilter(e.target.value)}
                className="rounded-md border border-slate-200 px-3 py-1.5 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-brand-500"
              >
                <option value="">All arenas</option>
                {arenas?.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-slate-500">Status</label>
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as BookingStatus | '')}
                className="rounded-md border border-slate-200 px-3 py-1.5 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-brand-500"
              >
                {STATUS_OPTIONS.map(({ value, label }) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>
      </Card>

      {/* ── Table ── */}
      {isLoading && (
        <div className="flex items-center gap-2 text-sm text-slate-500">
          <span className="block h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-slate-600" />
          Loading bookings…
        </div>
      )}

      {isError && (
        <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
          {(error as Error).message}
        </div>
      )}

      {!isLoading && !isError && bookings !== undefined && bookings.length === 0 && (
        <Card>
          <p className="py-4 text-center text-sm text-slate-500">
            No bookings found for the selected filters.
          </p>
        </Card>
      )}

      {!isLoading && !isError && bookings && bookings.length > 0 && (
        <div className="overflow-x-auto rounded-[var(--radius)] border border-[#e5e7eb] bg-white shadow-sm">
          <table className="w-full min-w-[700px] text-sm">
            <thead>
              <tr className="border-b border-[#e5e7eb] bg-slate-50">
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Customer
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Contact
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Arena
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Date / Time (IST)
                </th>
                <th className="px-4 py-3 text-center text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Slots
                </th>
                <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Total
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Status
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#f1f5f9]">
              {bookings.map((b: BookingListItem) => (
                <tr
                  key={b.id}
                  onClick={() => setSelectedBookingId(b.id)}
                  className="cursor-pointer transition-colors hover:bg-slate-50"
                >
                  <td className="px-4 py-3 font-medium text-slate-800">
                    {b.customerName ?? <span className="text-slate-400">—</span>}
                  </td>
                  <td className="px-4 py-3 text-slate-600">
                    {b.customerContact ?? <span className="text-slate-400">—</span>}
                  </td>
                  <td className="px-4 py-3 text-slate-600">{b.arenaName}</td>
                  <td className="px-4 py-3 text-slate-600">
                    {fmtIST(b.firstStartAt)}
                    {b.firstStartAt !== b.lastEndAt && (
                      <span className="text-slate-400"> – {fmtTimeIST(b.lastEndAt)}</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-center text-slate-600">{b.slotCount}</td>
                  <td className="px-4 py-3 text-right font-medium text-slate-800">
                    ₹{(b.totalPaise / 100).toFixed(0)}
                  </td>
                  <td className="px-4 py-3">
                    <Badge tone={statusTone(b.status)} label={b.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Booking detail modal ── */}
      <BookingDetailModal
        bookingId={selectedBookingId}
        venueId={venueId}
        onClose={() => setSelectedBookingId(null)}
      />
    </div>
  );
}

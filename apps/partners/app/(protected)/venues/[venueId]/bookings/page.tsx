'use client';

import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { useArenas, useBookingDetail, useBookingPayments, useVenueBookings, useVenues } from '@/lib/api/queries';
import type { BookingListItem, BookingStatus, Payment } from '@/lib/api/types';
import { Badge, BadgeTone, Button, Card, Input, Modal } from '@/lib/ui';
import { useOrg } from '@/lib/org_context';

// ──────────────────────────────────────────────────────────────────────────────
// Timezone-aware helpers
// ──────────────────────────────────────────────────────────────────────────────

/** Fallback tz while the venue is still loading. */
const FALLBACK_TZ = 'Asia/Kolkata';

/** Format an ISO string to a human-readable date+time in the given tz. */
function fmtInTz(iso: string, tz: string): string {
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

/** Format a time portion only in the given tz. */
function fmtTimeInTz(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

/**
 * Returns start/end of a calendar day in `tz` as UTC ISO strings.
 *
 * Uses `Intl.DateTimeFormat('en-CA', {timeZone: tz})` to determine the
 * calendar date, then samples the tz offset via a probe formatter to derive
 * that day's midnight-in-tz as an absolute UTC instant — no hardcoded offsets.
 *
 * @param date - A `Date` object or the string `'today'` (uses `new Date()`).
 * @param tz   - IANA timezone name, e.g. `'Asia/Kolkata'`.
 */
function dayBoundsInTz(date: Date | 'today', tz: string): { from: string; to: string } {
  const d = date === 'today' ? new Date() : date;

  // Step 1: determine the calendar date in `tz`.
  const calStr = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d); // 'YYYY-MM-DD'

  // Step 2: derive midnight-in-tz for that calendar date via offset sampling.
  // We construct a UTC instant for that date at 00:00 UTC, then measure the
  // difference between what that instant reads in `tz` versus UTC midnight,
  // and subtract to land on the true local midnight.
  const [y, m, day] = calStr.split('-').map(Number) as [number, number, number];

  // Probe: UTC instant for 'YYYY-MM-DDT00:00:00Z'
  const probeUtcMs = Date.UTC(y, m - 1, day);
  // What does that UTC instant read in `tz`?
  const probeParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date(probeUtcMs));
  const get = (type: string) => Number(probeParts.find((p) => p.type === type)?.value ?? '0');
  // Hours/minutes in tz at probeUtcMs — these represent how far past midnight we are in tz.
  const tzHour = get('hour');
  const tzMin = get('minute');
  const tzSec = get('second');
  const tzOffsetMs = (tzHour * 3600 + tzMin * 60 + tzSec) * 1000;

  // Midnight in tz = probeUtcMs − tzOffsetMs (could be previous calendar day in UTC).
  const midnightMs = probeUtcMs - tzOffsetMs;
  const nextMidnightMs = midnightMs + 24 * 60 * 60 * 1000;

  return {
    from: new Date(midnightMs).toISOString(),
    to: new Date(nextMidnightMs).toISOString(),
  };
}

type DateFilter = 'today' | 'upcoming' | 'past' | 'custom';

function computeDateBounds(
  filter: DateFilter,
  customFrom: string,
  customTo: string,
  tz: string,
): { from: string; to: string } {
  const now = new Date();
  switch (filter) {
    case 'today':
      return dayBoundsInTz('today', tz);
    case 'upcoming': {
      const in60d = new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000);
      return { from: now.toISOString(), to: in60d.toISOString() };
    }
    case 'past': {
      const ago60d = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);
      return { from: ago60d.toISOString(), to: now.toISOString() };
    }
    case 'custom': {
      // customFrom/customTo are 'YYYY-MM-DD' calendar dates in the venue tz.
      // Use noon UTC so that tz offsets ±12h don't shift the calendar date.
      if (!customFrom || !customTo) return dayBoundsInTz('today', tz);
      const fromBounds = dayBoundsInTz(new Date(`${customFrom}T12:00:00Z`), tz);
      const toBounds = dayBoundsInTz(new Date(`${customTo}T12:00:00Z`), tz);
      return { from: fromBounds.from, to: toBounds.to };
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
// CSV export
// ──────────────────────────────────────────────────────────────────────────────

/** Wrap a value as a CSV field, escaping quotes and forcing string type. */
function csvField(value: unknown): string {
  const s = value == null ? '' : String(value);
  // Always quote: simplest correct handling of commas, quotes, and newlines.
  return `"${s.replace(/"/g, '""')}"`;
}

/** Build a CSV string from the currently-displayed (filtered) booking rows. */
function bookingsToCsv(rows: BookingListItem[], tz: string): string {
  const headers = [
    'Booking ID',
    'Customer',
    'Contact',
    'Arena',
    'Start',
    'End',
    'Slots',
    'Total (₹)',
    'Status',
    'Channel',
    'Booked At',
  ];
  const lines = rows.map((b) =>
    [
      b.id,
      b.customerName ?? '',
      b.customerContact ?? '',
      b.arenaName,
      fmtInTz(b.firstStartAt, tz),
      fmtInTz(b.lastEndAt, tz),
      b.slotCount,
      (b.totalPaise / 100).toFixed(2),
      b.status,
      b.channel,
      fmtInTz(b.createdAt, tz),
    ]
      .map(csvField)
      .join(','),
  );
  return [headers.map(csvField).join(','), ...lines].join('\r\n');
}

/** Trigger a client-side download of `content` as a file named `filename`. */
function downloadCsv(content: string, filename: string): void {
  // Prepend a UTF-8 BOM so Excel renders the ₹ symbol and other characters correctly.
  const blob = new Blob([`﻿${content}`], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ──────────────────────────────────────────────────────────────────────────────
// Booking detail modal
// ──────────────────────────────────────────────────────────────────────────────

interface BookingDetailModalProps {
  bookingId: string | null;
  venueId: string;
  tz: string;
  onClose: () => void;
}

function paymentRowTone(p: Payment): BadgeTone {
  if (p.status === 'failed') return 'blocked';
  if (p.kind === 'refund') return 'warning';
  if (p.status === 'refunded' || p.status === 'partially_refunded') return 'warning';
  if (p.status === 'captured') return 'success';
  return 'open';
}

function BookingDetailModal({ bookingId, venueId, tz, onClose }: BookingDetailModalProps) {
  const router = useRouter();
  const { data: detail, isLoading, isError } = useBookingDetail(bookingId);
  const { data: paymentRows } = useBookingPayments(bookingId);

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
                <p className="mt-0.5 text-slate-700">{fmtInTz(detail.createdAt, tz)}</p>
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
                      {fmtInTz(slot.startAt, tz)} – {fmtTimeInTz(slot.endAt, tz)}
                    </span>
                    <span className="font-medium text-slate-800">₹{(slot.pricePaise / 100).toFixed(0)}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Payments ledger (Phase 14) — charges, refunds, adjustments. */}
            {paymentRows && paymentRows.length > 0 && (
              <div>
                <p className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400">
                  Payments ({paymentRows.length})
                </p>
                <div className="flex flex-col gap-1.5">
                  {paymentRows.map((p) => {
                    const sign = p.amountPaise < 0 ? '−' : '';
                    const abs = Math.abs(p.amountPaise);
                    return (
                      <div
                        key={p.id}
                        className="flex items-center justify-between rounded-md border border-slate-100 bg-white px-3 py-2 text-sm"
                      >
                        <div className="flex flex-col">
                          <span className="font-medium text-slate-700">
                            {p.kind === 'refund' ? 'Refund' : p.kind === 'charge' ? 'Charge' : 'Adjustment'}
                            <span className="ml-2 text-xs font-normal text-slate-400">{p.provider}</span>
                          </span>
                          <span className="text-xs text-slate-500">{fmtInTz(p.createdAt, tz)}</span>
                        </div>
                        <div className="flex items-center gap-3">
                          <Badge tone={paymentRowTone(p)} label={p.status} />
                          <span className={`font-medium ${p.amountPaise < 0 ? 'text-amber-700' : 'text-slate-800'}`}>
                            {sign}₹{(abs / 100).toFixed(0)}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Actions */}
            {isCancellable && (
              <div className="flex justify-end border-t border-slate-100 pt-4">
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => bookingId && router.push(`/bookings/${bookingId}/cancel`)}
                >
                  Cancel booking
                </Button>
              </div>
            )}
          </div>
        )}
      </Modal>
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

  // ── Resolve venue timezone ──
  const { activeTenantId } = useOrg();
  const { data: venues } = useVenues(activeTenantId ?? '');
  const tz = venues?.find((v) => v.id === venueId)?.tzName ?? FALLBACK_TZ;

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
    () => computeDateBounds(dateFilter, customFrom, customTo, tz),
    [dateFilter, customFrom, customTo, tz],
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

  // ── CSV download of the currently-filtered rows ──
  const hasRows = Boolean(bookings && bookings.length > 0);
  function handleDownloadCsv() {
    if (!bookings || bookings.length === 0) return;
    const stamp = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    downloadCsv(bookingsToCsv(bookings, tz), `bookings-${stamp}.csv`);
  }

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
        <Button
          variant="secondary"
          size="sm"
          onClick={handleDownloadCsv}
          disabled={!hasRows}
          title={hasRows ? 'Download the filtered bookings as CSV' : 'No bookings to download'}
        >
          Download CSV
        </Button>
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
                  Date / Time
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
                    {fmtInTz(b.firstStartAt, tz)}
                    {b.firstStartAt !== b.lastEndAt && (
                      <span className="text-slate-400"> – {fmtTimeInTz(b.lastEndAt, tz)}</span>
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
        tz={tz}
        onClose={() => setSelectedBookingId(null)}
      />
    </div>
  );
}

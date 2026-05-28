'use client';

import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Matrix } from '@/components/Matrix';
import { AddBookingModal } from '@/components/AddBookingModal';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useArena, useArenaSlots, useBulkSlots, useCancelBookingById, useVenues } from '@/lib/api/queries';
import { useOrg } from '@/lib/org_context';
import { Card } from '@/lib/ui';

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

/** Fallback tz while venue is resolving — prevents a crash on first render. */
const FALLBACK_TZ = 'Asia/Kolkata';

/** Return the Sunday on/before today (browser local date). */
function thisSunday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - d.getDay());
  return d;
}

function addDays(date: Date, n: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

// ──────────────────────────────────────────────────────────────────────────────
// Page
// ──────────────────────────────────────────────────────────────────────────────

export default function ArenaReceptionPage() {
  const { arenaId } = useParams<{ arenaId: string }>();
  const tenantId = useSearchParams().get('tenantId') ?? '';

  // ── Resolve venue timezone ──
  const { activeTenantId } = useOrg();
  const { data: arena } = useArena(arenaId);
  const { data: venues } = useVenues(activeTenantId ?? '');
  const tz = venues?.find((v) => v.id === arena?.venueId)?.tzName ?? FALLBACK_TZ;

  // ── Week state ──
  const [weekStart, setWeekStart] = useState<Date>(thisSunday);

  // ── Ticking now (for time-awareness UI) ──
  const [now, setNow] = useState<Date>(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);

  // Widen the fetch window by ±1 day to absorb browser↔venue timezone skew so
  // boundary slots are never clipped. The Matrix still places slots into the
  // correct 7 columns using the venue tz (IST); this only widens the fetch.
  // NOTE: single-tz assumption (IST/Asia/Kolkata) — full tz-correct windowing
  // is deferred; see the matching caveat in slot_service.ts.
  const fromIso = useMemo(() => addDays(weekStart, -1).toISOString(), [weekStart]);
  const toIso = useMemo(() => addDays(weekStart, 8).toISOString(), [weekStart]);

  // ── Slots query ──
  const { data: rawSlots, isLoading, isError, error } = useArenaSlots(arenaId, fromIso, toIso);

  // Memoize the slots array so Matrix selection is NOT reset on background refetch
  const slots = useMemo(() => rawSlots ?? [], [rawSlots]);

  // ── Mutations ──
  const bulk = useBulkSlots();
  const cancel = useCancelBookingById(arenaId);

  // ── Booking modal state ──
  const [bookingOpen, setBookingOpen] = useState(false);
  const [bookingSlotIds, setBookingSlotIds] = useState<string[]>([]);

  // ── Cancel confirm state ──
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [cancelBookingId, setCancelBookingId] = useState<string>('');

  // ── Price-change confirm state ──
  const [priceConfirmOpen, setPriceConfirmOpen] = useState(false);
  const [pendingPricePatch, setPendingPricePatch] = useState<{
    slotIds: string[];
    patch: { price?: number; blocked?: boolean };
  } | null>(null);

  // ── Matrix callbacks ──
  const handlePrevWeek = useCallback(() => {
    setWeekStart((prev) => addDays(prev, -7));
  }, []);

  const handleNextWeek = useCallback(() => {
    setWeekStart((prev) => addDays(prev, 7));
  }, []);

  const handleBulk = useCallback(
    (slotIds: string[], patch: { price?: number; blocked?: boolean }) => {
      if (patch.price !== undefined) {
        // Route price changes through a confirm dialog
        setPendingPricePatch({ slotIds, patch });
        setPriceConfirmOpen(true);
      } else {
        // Block/unblock is immediate
        bulk.mutate({ slotIds, ...patch });
      }
    },
    [bulk],
  );

  const handleBook = useCallback((slotIds: string[]) => {
    setBookingSlotIds(slotIds);
    setBookingOpen(true);
  }, []);

  const handleCancel = useCallback((bookingId: string) => {
    setCancelBookingId(bookingId);
    setConfirmOpen(true);
  }, []);

  // ──────────────────────────────────────────────────────────────────────────
  // Render
  // ──────────────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <Link href="/dashboard" className="hover:underline">
              Dashboard
            </Link>
            <span>/</span>
            <span className="font-medium text-slate-700">Reception</span>
          </div>
          <h1 className="mt-1 text-xl font-semibold text-slate-800">Reception</h1>
        </div>

        <Link
          href={`/arenas/${arenaId}/schedule${tenantId ? `?tenantId=${tenantId}` : ''}`}
          className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-50"
        >
          Schedule builder →
        </Link>
      </div>

      {/* Loading / error / empty */}
      {isLoading && (
        <p className="text-sm text-slate-500">Loading slots…</p>
      )}
      {isError && (
        <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
          {(error as Error).message}
        </div>
      )}
      {!isLoading && !isError && slots.length === 0 && (
        <Card>
          <div className="flex flex-col gap-2 text-center py-4">
            <p className="text-sm text-slate-500">No slots released for this week.</p>
            <p className="text-xs text-slate-400">
              Use the{' '}
              <Link
                href={`/arenas/${arenaId}/schedule${tenantId ? `?tenantId=${tenantId}` : ''}`}
                className="font-medium text-brand-600 hover:underline"
              >
                schedule builder
              </Link>{' '}
              to release slots first.
            </p>
          </div>
        </Card>
      )}

      {/* Matrix */}
      {!isLoading && !isError && (
        <Matrix
          mode="reception"
          slots={slots}
          weekStart={weekStart}
          tz={tz}
          now={now}
          onBulk={handleBulk}
          onBook={handleBook}
          onCancel={handleCancel}
          onPrevWeek={handlePrevWeek}
          onNextWeek={handleNextWeek}
        />
      )}

      {/* Add booking modal */}
      <AddBookingModal
        arenaId={arenaId}
        open={bookingOpen}
        slotIds={bookingSlotIds}
        slots={slots}
        onClose={() => setBookingOpen(false)}
      />

      {/* Cancel booking confirm */}
      <ConfirmDialog
        open={confirmOpen}
        title="Cancel booking?"
        message="This frees the slot(s) and is logged."
        confirmLabel="Cancel booking"
        danger
        onConfirm={() => {
          if (cancelBookingId) cancel.mutate(cancelBookingId);
        }}
        onClose={() => setConfirmOpen(false)}
      />

      {/* Price-change confirm */}
      <ConfirmDialog
        open={priceConfirmOpen}
        title="Apply price change?"
        message={
          pendingPricePatch?.patch.price !== undefined
            ? `Set price to ₹${((pendingPricePatch.patch.price) / 100).toFixed(0)} for ${pendingPricePatch.slotIds.length} slot(s)?`
            : ''
        }
        confirmLabel="Apply"
        onConfirm={() => {
          if (pendingPricePatch) {
            bulk.mutate({ slotIds: pendingPricePatch.slotIds, ...pendingPricePatch.patch });
            setPendingPricePatch(null);
          }
        }}
        onClose={() => {
          setPriceConfirmOpen(false);
          setPendingPricePatch(null);
        }}
      />
    </div>
  );
}

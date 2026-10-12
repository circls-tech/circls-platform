'use client';

import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Matrix } from '@/components/Matrix';
import { AddBookingModal } from '@/components/AddBookingModal';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { QrTicketConfigEditor } from '@/components/QrTicketConfigEditor';
import { CloseReopenControl } from '@/components/CloseReopenControl';
import {
  useArena,
  useArenaSlots,
  useBulkSlots,
  useCancelBookingById,
  useMyRole,
  useRefundPreview,
  useSetArenaOpen,
  useUpdateArenaQrConfig,
  useVenues,
} from '@/lib/api/queries';
import type { QrTicketConfig } from '@/lib/api/types';
import { refundSentence } from '@/lib/bookings/refund_copy';
import { formatMoney, useCurrency } from '@/lib/currency';
import { useOrg } from '@/lib/org_context';
import { useTimezone } from '@/lib/timezone_context';
import { Badge, Button, Card, StatusPill } from '@/lib/ui';

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

  // The arena's organisation: the one in the link, else the active one.
  const { activeTenantId } = useOrg();
  const orgId = tenantId || activeTenantId;

  // ── Resolve venue timezone ──
  const { data: arena } = useArena(arenaId);
  const setArenaOpen = useSetArenaOpen(arenaId, arena?.venueId ?? '');
  const { data: venues } = useVenues(orgId ?? '');
  const tz = venues?.find((v) => v.id === arena?.venueId)?.tzName ?? FALLBACK_TZ;
  const currency = useCurrency({ venueId: arena?.venueId });

  // The grid is *displayed* in the portal-wide viewing timezone (top-bar
  // selector). On "Auto" this falls back to the venue's own tz. Slot times,
  // day-column bucketing and the today highlight all follow `displayTz` so the
  // whole grid is internally consistent in whatever zone you're viewing.
  const { resolveTz } = useTimezone();
  const displayTz = resolveTz(tz);

  // ── Week state ──
  const [weekStart, setWeekStart] = useState<Date>(thisSunday);

  // ── Ticking now (for time-awareness UI) ──
  const [now, setNow] = useState<Date>(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);

  // Widen the fetch window by ±1 day to absorb browser↔display timezone skew so
  // boundary slots are never clipped. The Matrix places slots into the correct 7
  // columns using `displayTz`; this only widens the fetch (±1 day comfortably
  // covers the max ~14h tz offset). Slots are absolute instants, so changing the
  // viewing zone only re-labels/re-buckets them — it never moves a slot in time.
  const fromIso = useMemo(() => addDays(weekStart, -1).toISOString(), [weekStart]);
  const toIso = useMemo(() => addDays(weekStart, 8).toISOString(), [weekStart]);

  // ── Slots query ──
  const { data: rawSlots, isLoading, isError, error } = useArenaSlots(arenaId, fromIso, toIso);

  // Memoize the slots array so Matrix selection is NOT reset on background refetch
  const slots = useMemo(() => rawSlots ?? [], [rawSlots]);

  // ── Mutations ──
  const bulk = useBulkSlots();
  const cancel = useCancelBookingById(arenaId);
  const updateQrConfig = useUpdateArenaQrConfig(arenaId);

  // ── QR ticket config editor state ──
  // Local draft, hydrated once per arena load — a background refetch (same id)
  // must not clobber in-progress edits.
  const [qrConfig, setQrConfig] = useState<QrTicketConfig | null>(null);
  const [qrLoadedFor, setQrLoadedFor] = useState<string | null>(null);
  const [qrSaved, setQrSaved] = useState(false);
  const [qrErr, setQrErr] = useState<string | null>(null);
  useEffect(() => {
    if (!arena || arena.id === qrLoadedFor) return;
    setQrLoadedFor(arena.id);
    setQrConfig(arena.qrTicketConfig ?? null);
  }, [arena, qrLoadedFor]);

  async function saveQrConfig() {
    setQrErr(null);
    setQrSaved(false);
    try {
      await updateQrConfig.mutateAsync(qrConfig);
      setQrSaved(true);
    } catch (e) {
      setQrErr((e as Error).message);
    }
  }

  // ── Booking modal state ──
  const [bookingOpen, setBookingOpen] = useState(false);
  const [bookingSlotIds, setBookingSlotIds] = useState<string[]>([]);

  // ── Cancel confirm state ──
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [cancelBookingId, setCancelBookingId] = useState<string>('');
  // Cancelling here is a staff cancel: a booking paid online is refunded in
  // full. Show the server's decision before the confirm, not after.
  const cancelRefund = useRefundPreview(confirmOpen ? cancelBookingId || null : null);
  const cancelRefundText = cancelRefund.data
    ? refundSentence(cancelRefund.data, (p) => formatMoney(p, currency, { decimals: 2 }), 'customer')
    : cancelRefund.isError
      ? 'Couldn’t work out whether a refund is due — circls decides it when you confirm.'
      : 'Working out the refund…';
  // Staff work the desk — booking and cancelling — but not the arena's setup
  // (prices, blocks, schedule, QR rules, closing it); Read-only does neither.
  // Decided by the arena's own organisation, which is what the API checks.
  const { can } = useMyRole(orgId);
  const canBook = can('bookings.create');
  const canCancel = can('bookings.cancel');
  const canSchedule = can('schedules.write');
  const canEditArena = can('arenas.write');

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
          <h1 className="mt-1 font-[family-name:var(--font-display)] text-2xl font-extrabold tracking-tight text-[#17151D]">Reception</h1>
          {arena && (
            <div className="mt-1 flex items-center gap-2 text-sm text-slate-600">
              <span className="font-medium">{arena.name}</span>
              <StatusPill
                status={arena.status}
                {...(arena.status === 'suspended' ? { label: 'Closed' } : {})}
              />
              {arena.autoRolloverEnabled && (
                <Badge
                  tone="success"
                  label="Auto-rollover on"
                  title="The next 7 days are kept released from the saved weekly plan."
                />
              )}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          {canSchedule && (
            <Link
              href={`/arenas/${arenaId}/schedule${tenantId ? `?tenantId=${tenantId}` : ''}`}
              className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-50"
            >
              Schedule builder →
            </Link>
          )}
          {/* Closing an arena, like closing its venue, is venues.write. */}
          {arena && can('venues.write') && (
            <CloseReopenControl
              noun="arena"
              target={arena}
              venueId={arena.venueId}
              arenaId={arena.id}
              tenantId={tenantId}
              setOpen={setArenaOpen}
            />
          )}
        </div>
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
            {canSchedule && (
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
            )}
          </div>
        </Card>
      )}

      {/* Matrix */}
      {!isLoading && !isError && (
        <Matrix
          mode="reception"
          slots={slots}
          weekStart={weekStart}
          tz={displayTz}
          currency={currency}
          dayStartMin={arena?.businessDayStartMin ?? 0}
          now={now}
          onBulk={handleBulk}
          onBook={canBook ? handleBook : undefined}
          onCancel={canCancel ? handleCancel : undefined}
          canSetPrice={can('pricing.write')}
          canBlock={canSchedule}
          onPrevWeek={handlePrevWeek}
          onNextWeek={handleNextWeek}
        />
      )}

      {/* QR ticket rules: everyone sees them; only arenas.write changes them. */}
      {arena && (
        <Card
          title="QR tickets"
          subtitle="Issue scannable door passes for bookings on this arena. Changes only affect future bookings."
        >
          <fieldset disabled={!canEditArena} className="flex min-w-0 max-w-2xl flex-col gap-3">
            <QrTicketConfigEditor
              value={qrConfig}
              onChange={(v) => {
                setQrConfig(v);
                setQrSaved(false);
              }}
              itemNoun="booking"
            />
            {qrErr && <p className="text-sm text-red-600">{qrErr}</p>}
            {canEditArena && (
              <div className="flex items-center justify-end gap-3">
                {qrSaved && !updateQrConfig.isPending && (
                  <span className="text-xs text-emerald-600">Saved.</span>
                )}
                <Button size="sm" loading={updateQrConfig.isPending} onClick={() => void saveQrConfig()}>
                  Save
                </Button>
              </div>
            )}
          </fieldset>
        </Card>
      )}

      {/* Add booking modal */}
      <AddBookingModal
        arenaId={arenaId}
        currency={currency}
        open={bookingOpen}
        slotIds={bookingSlotIds}
        slots={slots}
        onClose={() => setBookingOpen(false)}
      />

      {/* Cancel booking confirm */}
      <ConfirmDialog
        open={confirmOpen}
        title="Cancel booking?"
        message={`This frees the slot(s) and is logged. ${cancelRefundText}`}
        confirmLabel="Cancel booking"
        danger
        confirmDisabled={cancelRefund.isLoading}
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
            ? `Set price to ${formatMoney(pendingPricePatch.patch.price, currency)} for ${pendingPricePatch.slotIds.length} slot(s)?`
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

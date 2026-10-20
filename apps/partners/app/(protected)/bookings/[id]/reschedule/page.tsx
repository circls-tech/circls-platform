'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  useArenaSlots,
  useArenas,
  useBookingDetail,
  useMyRole,
  useRescheduleBooking,
} from '@/lib/api/queries';
import { ApiError } from '@/lib/api/client';
import type { RescheduleResult, Slot } from '@/lib/api/types';
import { formatMoney, useCurrency } from '@/lib/currency';
import { isArenaLive } from '@/lib/shelf';
import { dayBoundsInTz } from '@/lib/time';
import { useTimezone } from '@/lib/timezone_context';
import { RoleNotice } from '@/components/RoleNotice';
import { BackLink, Badge, Button, Card, Input } from '@/lib/ui';

/** The calendar date of `d` in `tz`, as YYYY-MM-DD. */
function ymdInTz(d: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/**
 * Move a confirmed court booking to other slots at its venue: another time,
 * another day, another court. The booking keeps its id, customer and
 * payment; the API moves the slots, passes and reminders in one go, and
 * tells the customer. Money does not move here — the difference between
 * what was paid and what the new slots cost is shown, for the counter.
 */
export default function RescheduleBookingPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { data: booking, isLoading, isError, error } = useBookingDetail(id);
  const reschedule = useRescheduleBooking();
  const currency = useCurrency({ venueId: booking?.venueId });
  const money = (paise: number) => formatMoney(paise, currency, { decimals: 2 });

  // Times follow the portal-wide viewing tz (Auto = your local time), as the
  // bookings list and the refund page do.
  const { resolveTz } = useTimezone();
  const tz = resolveTz();
  const slotFmt = useMemo(
    () =>
      new Intl.DateTimeFormat('en-IN', {
        timeZone: tz,
        year: 'numeric',
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }),
    [tz],
  );
  const timeFmt = useMemo(
    () => new Intl.DateTimeFormat('en-IN', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }),
    [tz],
  );
  const dayFmt = useMemo(
    () => new Intl.DateTimeFormat('en-IN', { timeZone: tz, weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' }),
    [tz],
  );

  // Owners, Managers and Staff may move a booking (the same right as
  // cancelling it); Read-only can't — in the booking's own organisation.
  const { can, isLoading: roleLoading } = useMyRole(booking?.tenantId);
  const canMove = can('bookings.cancel');

  const firstSlotStart = booking?.slots[0]?.startAt;
  const started = Boolean(firstSlotStart && new Date(firstSlotStart).getTime() <= Date.now());
  const movable = Boolean(booking) && booking?.status === 'confirmed' && (booking?.slots.length ?? 0) > 0 && !started;

  // Where to look: a court of the venue (the booking's own first), a day.
  const { data: arenas } = useArenas(booking?.venueId ?? '');
  const liveArenas = useMemo(() => (arenas ?? []).filter((a) => isArenaLive(a)), [arenas]);
  const [arenaId, setArenaId] = useState('');
  useEffect(() => {
    if (!arenaId && booking?.arenaId) setArenaId(booking.arenaId);
  }, [arenaId, booking?.arenaId]);
  const [day, setDay] = useState<Date>(() => new Date());
  useEffect(() => {
    if (firstSlotStart) setDay(new Date(firstSlotStart));
    // The booking's own day is the natural starting point, once known.
  }, [firstSlotStart]);
  const bounds = useMemo(() => dayBoundsInTz(day, tz), [day, tz]);
  const { data: daySlots, isLoading: slotsLoading } = useArenaSlots(arenaId, bounds.from, bounds.to, {
    enabled: Boolean(arenaId) && movable,
  });

  // What can be picked: open, still ahead — plus the booking's own slots on
  // this court, so shifting an hour along is a matter of re-ticking them.
  const ownIds = useMemo(() => new Set(booking?.slots.map((s) => s.id) ?? []), [booking]);
  const pickable: Slot[] = useMemo(() => {
    const now = Date.now();
    return (daySlots ?? [])
      .filter((s) => new Date(s.startAt).getTime() > now)
      .filter((s) => s.status === 'open' || ownIds.has(s.id))
      .sort((a, b) => a.startAt.localeCompare(b.startAt));
  }, [daySlots, ownIds]);

  const [picked, setPicked] = useState<Map<string, Slot>>(new Map());
  function toggle(s: Slot) {
    setPicked((prev) => {
      const next = new Map(prev);
      if (next.has(s.id)) next.delete(s.id);
      else next.set(s.id, s);
      return next;
    });
  }
  // A pick is one court: switching courts starts the selection over.
  useEffect(() => {
    setPicked(new Map());
  }, [arenaId]);

  const pickedList = useMemo(
    () => [...picked.values()].sort((a, b) => a.startAt.localeCompare(b.startAt)),
    [picked],
  );
  const newTotal = pickedList.reduce((sum, s) => sum + s.pricePaise, 0);
  const paid = booking?.totalPaise ?? 0;
  const delta = newTotal - paid;
  const sameAsNow =
    pickedList.length > 0 &&
    pickedList.length === ownIds.size &&
    pickedList.every((s) => ownIds.has(s.id));

  const [reason, setReason] = useState('');
  // Ticked when the difference changes hands at the counter as part of the
  // move; it goes into the booking's ledger as an adjustment. Otherwise it
  // can be marked settled later from the booking's detail.
  const [settleNow, setSettleNow] = useState(false);
  const [result, setResult] = useState<RescheduleResult | null>(null);
  const submitting = reschedule.isPending;
  const apiError = reschedule.error instanceof ApiError ? reschedule.error : null;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!id || pickedList.length === 0 || sameAsNow || submitting) return;
    reschedule.mutate(
      {
        bookingId: id,
        slotIds: pickedList.map((s) => s.id),
        reason: reason.trim() || 'Rescheduled by venue',
        ...(delta !== 0 && settleNow ? { settleNow: true } : {}),
      },
      { onSuccess: (data) => setResult(data) },
    );
  }

  const back = booking
    ? { href: `/venues/${booking.venueId}/bookings`, label: 'Bookings' }
    : { href: '/dashboard', label: 'Dashboard' };

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6">
      <BackLink href={back.href}>{back.label}</BackLink>
      <h1 className="font-[family-name:var(--font-display)] text-2xl font-extrabold tracking-tight text-[#17151D]">Reschedule booking</h1>

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
          <Card>
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
                <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Currently</p>
                <p className="mt-0.5 text-slate-700">{booking.arenaName}</p>
                <ul className="mt-0.5 text-slate-700">
                  {booking.slots.map((s) => (
                    <li key={s.id}>
                      {slotFmt.format(new Date(s.startAt))} – {timeFmt.format(new Date(s.endAt))}
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Paid</p>
                <p className="mt-0.5 font-medium text-slate-800">{money(paid)}</p>
                <p className="mt-0.5 text-xs text-slate-500">{booking.paymentMethod}</p>
              </div>
            </div>
          </Card>

          {!roleLoading && !canMove && (
            <RoleNotice tenantId={booking.tenantId}>
              Your role can&apos;t reschedule bookings — Owners, Managers and Staff can.
            </RoleNotice>
          )}

          {!movable && !result && (
            <Card>
              <p className="py-2 text-sm text-slate-600">
                {booking.status !== 'confirmed'
                  ? `A ${booking.status} booking can't be rescheduled.`
                  : started
                    ? 'This booking has already started, so it can’t be moved. Mark it a no-show or refund it instead.'
                    : 'This booking holds no court slots to move.'}
              </p>
            </Card>
          )}

          {movable && canMove && !result && (
            <form onSubmit={handleSubmit} className="flex flex-col gap-6">
              <Card title="Move it to" subtitle="Pick a court and a day, then tick the slots. Only open slots are offered.">
                <div className="flex flex-col gap-4">
                  <div className="flex flex-wrap items-end gap-3">
                    <label className="flex flex-col gap-1 text-sm">
                      <span className="text-[11px] font-medium uppercase tracking-wide text-[#475569]">Court</span>
                      <select
                        value={arenaId}
                        onChange={(e) => setArenaId(e.target.value)}
                        className="rounded-[var(--radius)] border border-[#e5e7eb] bg-white px-3 py-1.5 text-sm text-[#0f172a]"
                      >
                        {liveArenas.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <div className="flex items-center gap-2">
                      <Button type="button" variant="secondary" size="sm" onClick={() => setDay((d) => new Date(d.getTime() - 86_400_000))} aria-label="Previous day">
                        ◀
                      </Button>
                      <span className="min-w-[11rem] text-center text-sm font-medium text-slate-800">{dayFmt.format(day)}</span>
                      <Button type="button" variant="secondary" size="sm" onClick={() => setDay((d) => new Date(d.getTime() + 86_400_000))} aria-label="Next day">
                        ▶
                      </Button>
                      <input
                        type="date"
                        value={ymdInTz(day, tz)}
                        onChange={(e) => {
                          if (!e.target.value) return;
                          // Noon of the chosen date, read back in the viewing tz by dayBoundsInTz.
                          setDay(new Date(`${e.target.value}T12:00:00`));
                        }}
                        className="rounded-[var(--radius)] border border-[#e5e7eb] bg-white px-2 py-1.5 text-sm text-[#0f172a]"
                        aria-label="Pick a date"
                      />
                    </div>
                  </div>

                  {slotsLoading ? (
                    <p className="text-sm text-slate-500">Loading slots…</p>
                  ) : pickable.length === 0 ? (
                    <p className="text-sm text-slate-500">No open slots on this court that day.</p>
                  ) : (
                    <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                      {pickable.map((s) => {
                        const on = picked.has(s.id);
                        const own = ownIds.has(s.id);
                        return (
                          <li key={s.id}>
                            <button
                              type="button"
                              onClick={() => toggle(s)}
                              aria-pressed={on}
                              className={[
                                'flex w-full flex-col items-start rounded-[var(--radius)] border-2 px-3 py-2 text-left text-sm transition-colors',
                                on ? 'border-[#17151D] bg-brand-600 text-[#17151D]' : 'border-[#e5e7eb] bg-white text-slate-700 hover:border-slate-300',
                              ].join(' ')}
                            >
                              <span className="font-medium">
                                {timeFmt.format(new Date(s.startAt))} – {timeFmt.format(new Date(s.endAt))}
                              </span>
                              <span className="text-xs text-slate-500">
                                {money(s.pricePaise)}
                                {own && ' · theirs now'}
                              </span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              </Card>

              <Card>
                <div className="flex flex-col gap-4">
                  <div className="flex items-center justify-between rounded-lg bg-slate-50 px-4 py-3 text-sm">
                    <div>
                      <p className="font-medium text-slate-800">
                        {pickedList.length === 0
                          ? 'No slots picked yet'
                          : `${pickedList.length} slot${pickedList.length > 1 ? 's' : ''} · ${slotFmt.format(new Date(pickedList[0]!.startAt))} – ${timeFmt.format(new Date(pickedList[pickedList.length - 1]!.endAt))}`}
                      </p>
                      <p className="mt-0.5 text-xs text-slate-500">
                        {pickedList.length === 0
                          ? 'Tick the slots the booking should move to.'
                          : delta === 0
                            ? 'Same price as what was paid — nothing to settle.'
                            : delta > 0
                              ? `${money(delta)} more than was paid — collect it at the venue.`
                              : `${money(-delta)} less than was paid — settle the difference with the customer.`}
                      </p>
                    </div>
                    <p className="text-lg font-semibold text-slate-800">{money(newTotal)}</p>
                  </div>
                  <Input
                    label="Reason (optional, for the audit log)"
                    placeholder="e.g. Customer asked for Saturday"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                  />
                  {pickedList.length > 0 && delta !== 0 && (
                    <label className="flex items-start gap-2 text-sm text-slate-700">
                      <input
                        type="checkbox"
                        checked={settleNow}
                        onChange={(e) => setSettleNow(e.target.checked)}
                        className="mt-0.5"
                      />
                      <span>
                        {delta > 0
                          ? `${money(delta)} collected from the customer now`
                          : `${money(-delta)} handed back to the customer now`}
                        <span className="block text-xs text-slate-500">
                          Records it in the booking&apos;s payment history. Leave it unticked to mark it settled later from the booking.
                        </span>
                      </span>
                    </label>
                  )}
                  {apiError && <p className="text-sm text-red-600">{apiError.message}</p>}
                  {sameAsNow && (
                    <p className="text-sm text-slate-500">Those are the slots it already has.</p>
                  )}
                  <div className="flex justify-end gap-3">
                    <Button type="button" variant="ghost" size="sm" onClick={() => router.back()}>
                      Back
                    </Button>
                    <Button
                      type="submit"
                      petal="#A7E3BF"
                      size="sm"
                      loading={submitting}
                      disabled={pickedList.length === 0 || sameAsNow}
                    >
                      Move booking
                    </Button>
                  </div>
                </div>
              </Card>
            </form>
          )}

          {result && (
            <Card>
              <div className="flex flex-col gap-3">
                <p className="text-sm font-medium text-emerald-700">Booking moved. The customer has been told.</p>
                <div className="rounded-lg bg-emerald-50 px-4 py-3 text-sm">
                  <p className="font-medium text-slate-800">
                    {slotFmt.format(new Date(result.startAt))} – {timeFmt.format(new Date(result.endAt))}
                  </p>
                  <p className="mt-0.5 text-xs text-slate-500">
                    {result.priceDeltaPaise === 0
                      ? 'Same price as paid.'
                      : result.settledAt
                        ? result.priceDeltaPaise > 0
                          ? `${money(result.priceDeltaPaise)} collected at the venue — recorded.`
                          : `${money(-result.priceDeltaPaise)} handed back to the customer — recorded.`
                        : result.priceDeltaPaise > 0
                          ? `${money(result.priceDeltaPaise)} to collect at the venue. Mark it settled from the booking once it is.`
                          : `${money(-result.priceDeltaPaise)} owed back to the customer. Mark it settled from the booking once it is.`}
                  </p>
                </div>
                <div className="flex justify-end">
                  <Button variant="primary" size="sm" onClick={() => router.push(`/venues/${booking.venueId}/bookings`)}>
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

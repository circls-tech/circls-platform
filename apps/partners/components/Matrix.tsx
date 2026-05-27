'use client';

import { Fragment, useEffect, useRef, useState } from 'react';
import type { Slot } from '@/lib/api/types';
import { Badge, Button, Card, Input } from '@/lib/ui';
import { useBookingDetail } from '@/lib/api/queries';
import { useGridSelection } from './useGridSelection';

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

interface MatrixProps {
  slots: Slot[];
  weekStart: Date;           // Sunday of the visible week
  tz: string;                // venue IANA tz, e.g. 'Asia/Kolkata'
  mode: 'builder' | 'reception';
  now?: Date;                // ticking current time; reception-mode only
  onBulk: (slotIds: string[], patch: { price?: number; blocked?: boolean }) => void;
  onBook: (slotIds: string[]) => void;
  onCancel?: (bookingId: string) => void;
  onPrevWeek: () => void;
  onNextWeek: () => void;
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/** Cell min-height in px — must stay in sync with min-h-[40px] below. */
const CELL_MIN_H = 40;
/** Cell margin (m-0.5 = 2px each side = 4px total per cell). */
const CELL_MARGIN = 4;
/** Total row height including margins. */
const ROW_H = CELL_MIN_H + CELL_MARGIN;

function addDays(date: Date, n: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function fmtShortDate(date: Date): string {
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function fmtTimeKey(isoString: string, tz: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(isoString));
}

function getDayIndex(isoString: string, tz: string, weekStart: Date): number {
  // Determine which day-of-week the slot falls on (0=Sun … 6=Sat) in the venue tz.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
  }).formatToParts(new Date(isoString));
  const wd = parts.find((p) => p.type === 'weekday')?.value ?? '';
  const abbrs = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const slotDow = abbrs.indexOf(wd);

  // weekStart is always Sunday — compute offset.
  const weekStartDow = weekStart.getDay();
  return (slotDow - weekStartDow + 7) % 7;
}

/**
 * Returns whether a slot is "locked" (in the past) for reception mode.
 * A slot is locked when its start instant <= now (no timezone math needed —
 * both are absolute instants).
 */
function isSlotLocked(slot: Slot, now: Date): boolean {
  return new Date(slot.startAt).getTime() <= now.getTime();
}

/**
 * Returns a "YYYY-MM-DD" date string in the given IANA timezone.
 */
function localDateStr(date: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/**
 * Given a list of sorted time-key strings ("HH:mm") and the sorted slot list,
 * compute the fractional row offset (0..timeKeys.length) where `now` falls.
 *
 * - Before first slot row start → 0
 * - After last slot row end    → timeKeys.length
 * - Within a row               → rowIndex + elapsed_fraction
 * - In a gap between rows      → at the gap boundary (floor)
 *
 * `slotsByTimeKey` maps timeKey → first slot at that time (to get startAt/endAt).
 */
function computeNowRowOffset(
  timeKeys: string[],
  slotsByTimeKey: Map<string, Slot>,
  now: Date,
): number {
  if (timeKeys.length === 0) return 0;
  const nowMs = now.getTime();

  for (let i = 0; i < timeKeys.length; i++) {
    const tk = timeKeys[i]!;
    const slot = slotsByTimeKey.get(tk);
    if (!slot) continue;

    const rowStart = new Date(slot.startAt).getTime();
    const rowEnd = new Date(slot.endAt).getTime();

    if (nowMs < rowStart) {
      // now is before this row — either in a gap above it or before everything.
      return i;
    }
    if (nowMs >= rowStart && nowMs < rowEnd) {
      // now is within this row — compute fractional offset.
      const fraction = (nowMs - rowStart) / (rowEnd - rowStart);
      return i + fraction;
    }
    // nowMs >= rowEnd → now is at or after this row, continue to next.
  }

  // now is past the last row.
  return timeKeys.length;
}

// ──────────────────────────────────────────────────────────────────────────────
// Cell component
// ──────────────────────────────────────────────────────────────────────────────

interface CellProps {
  slot: Slot;
  isSelected: boolean;
  locked: boolean;
  onPointerDown: () => void;
  onPointerEnter: () => void;
}

function SlotCell({ slot, isSelected, locked, onPointerDown, onPointerEnter }: CellProps) {
  const toneMap: Record<Slot['status'], 'open' | 'booked' | 'blocked' | 'held'> = {
    open: 'open',
    booked: 'booked',
    blocked: 'blocked',
    held: 'held',
  };
  const priceDisplay =
    slot.status === 'open' ? `₹${(slot.pricePaise / 100).toFixed(0)}` : '';

  if (locked) {
    // Dimmed, non-interactive locked cell.
    return (
      <div
        className={[
          'relative flex items-center justify-center rounded p-1 select-none',
          'min-h-[40px] opacity-40 cursor-default',
        ].join(' ')}
      >
        <Badge
          tone={toneMap[slot.status]}
          label={priceDisplay || slot.status}
          className="w-full justify-center truncate text-[10px]"
        />
      </div>
    );
  }

  return (
    <div
      onPointerDown={onPointerDown}
      onPointerEnter={onPointerEnter}
      className={[
        'relative flex items-center justify-center rounded p-1 cursor-pointer select-none',
        'min-h-[40px] transition-shadow duration-100',
        isSelected ? 'ring-2 ring-amber-400 ring-offset-1' : '',
      ].join(' ')}
    >
      <Badge
        tone={toneMap[slot.status]}
        label={priceDisplay || slot.status}
        className="w-full justify-center truncate text-[10px]"
      />
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Inspector (right panel)
// ──────────────────────────────────────────────────────────────────────────────

interface InspectorProps {
  selected: Set<string>;
  slots: Slot[];
  mode: 'builder' | 'reception';
  onBulk: MatrixProps['onBulk'];
  onBook: MatrixProps['onBook'];
  onCancel?: MatrixProps['onCancel'];
}

function Inspector({ selected, slots, mode, onBulk, onBook, onCancel }: InspectorProps) {
  const [priceInput, setPriceInput] = useState('');

  const selectedSlots = slots.filter((s) => selected.has(s.id));
  const ids = selectedSlots.map((s) => s.id);
  const n = ids.length;

  // Determine whether we are in the single-booked-slot reception case so we can
  // conditionally fetch the booking detail.  Hook is called unconditionally;
  // `enabled` is false when the conditions are not met.
  const singleBookedSlot =
    mode === 'reception' && n === 1 && selectedSlots[0]?.status === 'booked'
      ? selectedSlots[0]
      : null;
  const detailBookingId = singleBookedSlot?.bookingId ?? null;
  const { data: bookingDetail } = useBookingDetail(detailBookingId);

  const hasLockedSlots = selectedSlots.some(
    (s) => s.status === 'booked' || s.status === 'held',
  );

  const prices = [...new Set(selectedSlots.map((s) => s.pricePaise))];
  const priceLabel =
    prices.length === 0
      ? '—'
      : prices.length === 1
        ? `₹${(prices[0]! / 100).toFixed(0)}`
        : 'Mixed';

  const allBlocked = selectedSlots.length > 0 && selectedSlots.every((s) => s.status === 'blocked');

  if (n === 0) {
    return (
      <Card className="flex flex-col gap-2">
        <p className="text-sm text-slate-400">Select slots to edit or book.</p>
      </Card>
    );
  }

  return (
    <Card title={`${n} selected`}>
      <div className="flex flex-col gap-4">
        {/* Current price summary */}
        <div className="text-sm text-slate-500">
          Current price: <span className="font-medium text-slate-700">{priceLabel}</span>
        </div>

        {hasLockedSlots && (
          <p className="rounded bg-amber-50 px-3 py-2 text-xs text-amber-700">
            Selection includes booked/held slots. Price and block actions are disabled.
          </p>
        )}

        {/* Price control */}
        <div className="flex flex-col gap-2">
          <Input
            label="Price (₹)"
            type="number"
            min={0}
            step={1}
            placeholder="e.g. 500"
            value={priceInput}
            onChange={(e) => setPriceInput(e.target.value)}
            disabled={hasLockedSlots}
          />
          <Button
            size="sm"
            variant="secondary"
            disabled={hasLockedSlots || priceInput.trim() === ''}
            onClick={() => {
              const rupees = Number(priceInput);
              if (isNaN(rupees) || rupees < 0) return;
              onBulk(ids, { price: Math.round(rupees * 100) });
              setPriceInput('');
            }}
          >
            Apply price
          </Button>
        </div>

        {/* Block / Unblock */}
        <Button
          size="sm"
          variant="ghost"
          disabled={hasLockedSlots}
          onClick={() => onBulk(ids, { blocked: !allBlocked })}
        >
          {allBlocked ? 'Unblock' : 'Block'}
        </Button>

        {/* Reception: Add booking */}
        {mode === 'reception' && (
          <Button
            size="sm"
            variant="primary"
            disabled={selectedSlots.some((s) => s.status !== 'open')}
            onClick={() => onBook(ids)}
          >
            Add booking
          </Button>
        )}

        {/* Reception: booked-slot customer info */}
        {singleBookedSlot && bookingDetail && (
          <div className="flex flex-col gap-1.5 rounded-md bg-blue-50 px-3 py-2.5 text-xs">
            <p className="font-semibold text-blue-800">
              {bookingDetail.customerName ?? '—'}
            </p>
            {bookingDetail.customerContact && (
              <p className="text-blue-700">{bookingDetail.customerContact}</p>
            )}
            {bookingDetail.note && (
              <p className="italic text-blue-600">{bookingDetail.note}</p>
            )}
            <p className="text-blue-700">
              Total: ₹{(bookingDetail.totalPaise / 100).toFixed(0)}
            </p>
          </div>
        )}

        {/* Reception: Cancel booking (single booked slot) */}
        {mode === 'reception' &&
          onCancel &&
          n === 1 &&
          selectedSlots[0]?.status === 'booked' &&
          selectedSlots[0]?.bookingId && (
            <Button
              size="sm"
              variant="danger"
              onClick={() => onCancel(selectedSlots[0]!.bookingId!)}
            >
              Cancel booking
            </Button>
          )}
      </div>
    </Card>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Matrix (main export)
// ──────────────────────────────────────────────────────────────────────────────

export function Matrix({
  slots,
  weekStart,
  tz,
  mode,
  now,
  onBulk,
  onBook,
  onCancel,
  onPrevWeek,
  onNextWeek,
}: MatrixProps) {
  const {
    selected,
    registerCell,
    handleCellPointerDown,
    handleCellPointerEnter,
    handlePointerUp,
    selectDay,
    selectRow,
  } = useGridSelection(slots, weekStart);

  // Build a sorted list of unique time-row labels.
  const timeKeys: string[] = [
    ...new Set(slots.map((s) => fmtTimeKey(s.startAt, tz))),
  ].sort();

  // Build a map: `${dayIndex}:${rowIndex}` → Slot
  // Also build slotsByTimeKey for now-line offset computation.
  const cellData = new Map<string, Slot>();
  const slotsByTimeKey = new Map<string, Slot>();

  // Determine which slots are locked (reception mode only).
  const lockedIds = new Set<string>();

  slots.forEach((slot) => {
    const dayIndex = getDayIndex(slot.startAt, tz, weekStart);
    const tk = fmtTimeKey(slot.startAt, tz);
    const rowIndex = timeKeys.indexOf(tk);
    if (dayIndex >= 0 && dayIndex <= 6 && rowIndex >= 0) {
      cellData.set(`${dayIndex}:${rowIndex}`, slot);

      if (!slotsByTimeKey.has(tk)) {
        slotsByTimeKey.set(tk, slot);
      }

      const locked = mode === 'reception' && now != null && isSlotLocked(slot, now);
      if (locked) lockedIds.add(slot.id);
      // Register every in-bounds cell with its locked flag. Selection helpers
      // skip locked cells, so this stays correct even as slots lock on the 60s
      // `now` tick (cellMap is not rebuilt between ticks).
      registerCell(slot.id, dayIndex, rowIndex, locked);
    }
  });

  // ── Today detection (reception mode) ──
  // Determine which column index corresponds to today in the venue tz.
  // Also check if today is within the currently displayed week.
  let todayColIndex: number | null = null;
  if (mode === 'reception' && now != null) {
    const todayStr = localDateStr(now, tz);
    for (let i = 0; i < 7; i++) {
      const colDate = addDays(weekStart, i);
      const colStr = localDateStr(colDate, tz);
      if (colStr === todayStr) {
        todayColIndex = i;
        break;
      }
    }
  }

  // ── Now-line position (reception mode) ──
  // Compute fractional row offset so we can position the line absolutely.
  let nowRowOffset: number | null = null;
  if (mode === 'reception' && now != null && todayColIndex !== null && timeKeys.length > 0) {
    nowRowOffset = computeNowRowOffset(timeKeys, slotsByTimeKey, now);
  }

  // Column headers: day labels + date.
  const dayHeaders = DAYS.map((day, i) => ({
    day,
    date: addDays(weekStart, i),
  }));

  // Week range label.
  const weekEnd = addDays(weekStart, 6);
  const weekLabel = `${fmtShortDate(weekStart)} – ${fmtShortDate(weekEnd)}`;

  // Pointer-up / pointer-cancel on document to end drag.
  const gridRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    document.addEventListener('pointerup', handlePointerUp);
    document.addEventListener('pointercancel', handlePointerUp);
    return () => {
      document.removeEventListener('pointerup', handlePointerUp);
      document.removeEventListener('pointercancel', handlePointerUp);
    };
  }, [handlePointerUp]);

  // ── Now-line: measure header row height so we can offset correctly ──
  // The grid has a header row (day headers), then time rows.
  // We wrap the time-rows section in a relative container and position
  // the line within it using nowRowOffset * ROW_H.
  const nowLineTop =
    nowRowOffset !== null
      ? Math.round(nowRowOffset * ROW_H)
      : null;

  // Render the "now" line for a given time-row if `now` falls within that row's
  // vertical span; null otherwise. Callers gate on today's column. Rendered for
  // BOTH filled and empty cells so the line never disappears in a gap or after
  // the last slot of the day.
  const renderNowLine = (rowIndex: number) => {
    if (nowLineTop === null) return null;
    const cellTop = rowIndex * ROW_H;
    if (nowLineTop < cellTop || nowLineTop >= cellTop + ROW_H) return null;
    return (
      <div
        className="pointer-events-none absolute left-0 right-0 z-10"
        style={{ top: nowLineTop - cellTop }}
      >
        <div className="relative flex items-center">
          {/* Red dot at the left edge */}
          <div className="absolute -left-1 h-2 w-2 rounded-full bg-red-500" />
          {/* Red rule spanning the column width */}
          <div className="h-0.5 w-full bg-red-500" />
        </div>
      </div>
    );
  };

  return (
    <div className="flex gap-4 w-full">
      {/* ── Left: grid ── */}
      <div className="flex-1 min-w-0 flex flex-col gap-3">
        {/* Week pager */}
        <div className="flex items-center gap-3">
          <Button size="sm" variant="ghost" onClick={onPrevWeek} aria-label="Previous week">
            ◀
          </Button>
          <span className="text-sm font-medium text-slate-600">{weekLabel}</span>
          <Button size="sm" variant="ghost" onClick={onNextWeek} aria-label="Next week">
            ▶
          </Button>
        </div>

        {/* Scrollable grid */}
        <div className="overflow-x-auto">
          <div
            ref={gridRef}
            className="grid min-w-[600px]"
            style={{ gridTemplateColumns: '64px repeat(7, 1fr)' }}
          >
            {/* ── Header row ── */}
            {/* top-left corner */}
            <div />
            {dayHeaders.map(({ day, date }, colIndex) => {
              const isToday = todayColIndex === colIndex;
              return (
                <button
                  key={colIndex}
                  className={[
                    'flex flex-col items-center py-2 text-xs font-semibold text-slate-500',
                    'hover:bg-slate-50 rounded cursor-pointer select-none',
                    isToday ? 'text-red-600' : '',
                  ].join(' ')}
                  onClick={() => selectDay(colIndex)}
                  title={`Select all ${day} slots`}
                >
                  <span className={isToday ? 'font-bold' : ''}>{day}</span>
                  <span
                    className={[
                      'text-[10px] font-normal',
                      isToday
                        ? 'mt-0.5 rounded-full bg-red-500 px-1.5 py-0.5 text-white font-semibold'
                        : 'text-slate-400',
                    ].join(' ')}
                  >
                    {fmtShortDate(date)}
                  </span>
                </button>
              );
            })}

            {/* ── Time rows (wrapped in relative for now-line) ── */}
            {/* We render time rows as a sub-grid overlay approach:
                The time rows are already inside the outer CSS grid.
                For the now-line we use a positioned overlay div
                placed OVER the today column cells, offset by nowLineTop.
                We accomplish this with a wrapper that spans the time rows section. */}
            {timeKeys.map((tk, rowIndex) => (
              <Fragment key={`row-${rowIndex}`}>
                {/* Time label */}
                <button
                  className={[
                    'flex items-center justify-end pr-2 text-[11px] font-mono text-slate-400',
                    'hover:text-slate-600 cursor-pointer select-none py-1',
                  ].join(' ')}
                  onClick={() => selectRow(rowIndex)}
                  title={`Select all ${tk} slots`}
                >
                  {tk}
                </button>

                {/* Day cells for this row */}
                {Array.from({ length: 7 }, (_, colIndex) => {
                  const key = `${colIndex}:${rowIndex}`;
                  const slot = cellData.get(key);
                  const isToday = todayColIndex === colIndex;

                  // Thin column tint for today (applied to empty cells and the wrapper div for filled cells).
                  const todayBg = isToday ? 'bg-red-50/50' : '';

                  if (!slot) {
                    return (
                      <div
                        key={key}
                        className={[
                          'relative min-h-[40px] rounded border border-dashed border-slate-100 m-0.5',
                          todayBg,
                        ].join(' ')}
                      >
                        {isToday && renderNowLine(rowIndex)}
                      </div>
                    );
                  }

                  const locked = lockedIds.has(slot.id);

                  return (
                    <div
                      key={key}
                      className={['m-0.5 relative', todayBg].join(' ')}
                    >
                      <SlotCell
                        slot={slot}
                        isSelected={selected.has(slot.id)}
                        locked={locked}
                        onPointerDown={() =>
                          handleCellPointerDown(slot.id, colIndex, rowIndex)
                        }
                        onPointerEnter={() =>
                          handleCellPointerEnter(colIndex, rowIndex)
                        }
                      />
                      {/* Now-line: shown when `now` falls within this row's span
                          (today's column only; same helper used for empty cells). */}
                      {isToday && renderNowLine(rowIndex)}
                    </div>
                  );
                })}
              </Fragment>
            ))}
          </div>
        </div>
      </div>

      {/* ── Right: inspector ── */}
      <div className="w-64 flex-shrink-0">
        <Inspector
          selected={selected}
          slots={slots}
          mode={mode}
          onBulk={onBulk}
          onBook={onBook}
          onCancel={onCancel}
        />
      </div>
    </div>
  );
}

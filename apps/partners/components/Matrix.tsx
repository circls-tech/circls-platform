'use client';

import { useEffect, useRef, useState } from 'react';
import type { Slot } from '@/lib/api/types';
import { Badge, Button, Card, Input } from '@/lib/ui';
import { useGridSelection } from './useGridSelection';

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

interface MatrixProps {
  slots: Slot[];
  weekStart: Date;           // Sunday of the visible week
  tz: string;                // venue IANA tz, e.g. 'Asia/Kolkata'
  mode: 'builder' | 'reception';
  onBulk: (slotIds: string[], patch: { price?: number; blocked?: boolean }) => void;
  onBook: (slotIds: string[]) => void;
  onPrevWeek: () => void;
  onNextWeek: () => void;
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

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

// ──────────────────────────────────────────────────────────────────────────────
// Cell component
// ──────────────────────────────────────────────────────────────────────────────

interface CellProps {
  slot: Slot;
  isSelected: boolean;
  onPointerDown: () => void;
  onPointerEnter: () => void;
}

function SlotCell({ slot, isSelected, onPointerDown, onPointerEnter }: CellProps) {
  const toneMap: Record<Slot['status'], 'open' | 'booked' | 'blocked' | 'held'> = {
    open: 'open',
    booked: 'booked',
    blocked: 'blocked',
    held: 'held',
  };
  const priceDisplay =
    slot.status === 'open' ? `₹${(slot.pricePaise / 100).toFixed(0)}` : '';

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
}

function Inspector({ selected, slots, mode, onBulk, onBook }: InspectorProps) {
  const [priceInput, setPriceInput] = useState('');

  const selectedSlots = slots.filter((s) => selected.has(s.id));
  const ids = selectedSlots.map((s) => s.id);
  const n = ids.length;

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
            onClick={() => onBook(ids)}
          >
            Add booking
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
  onBulk,
  onBook,
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
  const cellData = new Map<string, Slot>();
  slots.forEach((slot) => {
    const dayIndex = getDayIndex(slot.startAt, tz, weekStart);
    const tk = fmtTimeKey(slot.startAt, tz);
    const rowIndex = timeKeys.indexOf(tk);
    if (dayIndex >= 0 && dayIndex <= 6 && rowIndex >= 0) {
      cellData.set(`${dayIndex}:${rowIndex}`, slot);
      registerCell(slot.id, dayIndex, rowIndex);
    }
  });

  // Column headers: day labels + date.
  const dayHeaders = DAYS.map((day, i) => ({
    day,
    date: addDays(weekStart, i),
  }));

  // Week range label.
  const weekEnd = addDays(weekStart, 6);
  const weekLabel = `${fmtShortDate(weekStart)} – ${fmtShortDate(weekEnd)}`;

  // Pointer-up on document to end drag.
  const gridRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    document.addEventListener('pointerup', handlePointerUp);
    return () => document.removeEventListener('pointerup', handlePointerUp);
  }, [handlePointerUp]);

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
            {dayHeaders.map(({ day, date }, colIndex) => (
              <button
                key={colIndex}
                className={[
                  'flex flex-col items-center py-2 text-xs font-semibold text-slate-500',
                  'hover:bg-slate-50 rounded cursor-pointer select-none',
                ].join(' ')}
                onClick={() => selectDay(colIndex)}
                title={`Select all ${day} slots`}
              >
                <span>{day}</span>
                <span className="text-[10px] font-normal text-slate-400">
                  {fmtShortDate(date)}
                </span>
              </button>
            ))}

            {/* ── Time rows ── */}
            {timeKeys.map((tk, rowIndex) => (
              <>
                {/* Time label */}
                <button
                  key={`row-${rowIndex}`}
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
                  if (!slot) {
                    return (
                      <div
                        key={key}
                        className="min-h-[40px] rounded border border-dashed border-slate-100 m-0.5"
                      />
                    );
                  }
                  return (
                    <div key={key} className="m-0.5">
                      <SlotCell
                        slot={slot}
                        isSelected={selected.has(slot.id)}
                        onPointerDown={() =>
                          handleCellPointerDown(slot.id, colIndex, rowIndex)
                        }
                        onPointerEnter={() =>
                          handleCellPointerEnter(colIndex, rowIndex)
                        }
                      />
                    </div>
                  );
                })}
              </>
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
        />
      </div>
    </div>
  );
}

'use client';

import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Matrix } from '@/components/Matrix';
import { Button, Card, Input } from '@/lib/ui';
import { useArena, useReleaseSlots, useVenues, type ReleaseCell } from '@/lib/api/queries';
import { useOrg } from '@/lib/org_context';
import { useTimezone } from '@/lib/timezone_context';
import { fmtTzOffset } from '@/lib/time';
import {
  type Band,
  expandBandsToCells,
  minToTime,
  parseTimeToMin,
  validateBands,
} from '@/lib/schedule/bands';
import type { ScheduleTemplate, Slot } from '@/lib/api/types';

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

/** A band row in the editor — times kept as 'HH:MM' strings for the inputs. */
interface BandRow {
  startTime: string;
  endTime: string;
  priceRupees: number;
}

type PreviewSlot = Slot;

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

/** Return the Sunday on/before the given YYYY-MM-DD string (local). */
function sundayOnOrBefore(dateStr: string): Date {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() - d.getDay());
  return d;
}

/** A preview-slot id encodes its release-cell shape so edits survive round-trip. */
function cellId(dow: number, startTimeMin: number, durationMin: number): string {
  return `prev-${dow}-${startTimeMin}-${durationMin}`;
}

function parseCellId(id: string): { dayOfWeek: number; startTimeMin: number; durationMin: number } | null {
  const m = /^prev-(\d+)-(\d+)-(\d+)$/.exec(id);
  if (!m) return null;
  return { dayOfWeek: Number(m[1]), startTimeMin: Number(m[2]), durationMin: Number(m[3]) };
}

/** Map the band-editor rows to the pure Band model. */
function rowsToBands(rows: BandRow[]): Band[] {
  return rows.map((r) => ({
    startMin: parseTimeToMin(r.startTime),
    endMin: parseTimeToMin(r.endTime),
    priceRupees: r.priceRupees,
  }));
}

/**
 * Build a synthetic grid of Slot-shaped objects for one representative week from
 * the release cells. Each cell is anchored to the Sunday of the preview week; an
 * overnight cell (startTimeMin ≥ 1440) naturally rolls into the next calendar
 * day, and the business-day-aware Matrix buckets it back under its owning day.
 */
function buildPreviewSlots(cells: ReleaseCell[], weekStart: Date, arenaId: string): PreviewSlot[] {
  return cells.map((c) => {
    const dayBase = new Date(weekStart);
    dayBase.setDate(dayBase.getDate() + c.dayOfWeek);
    const startMs = dayBase.getTime() + c.startTimeMin * 60_000;
    const endMs = startMs + c.durationMin * 60_000;
    const startAt = new Date(startMs).toISOString();
    const endAt = new Date(endMs).toISOString();
    return {
      id: cellId(c.dayOfWeek, c.startTimeMin, c.durationMin),
      tenantId: '',
      arenaId,
      timeRange: `[${startAt},${endAt})`,
      pricePaise: c.price ?? 0,
      status: c.blocked ? 'blocked' : 'open',
      holdExpiresAt: null,
      heldByUserId: null,
      bookingId: null,
      releaseId: null,
      deletedAt: null,
      createdAt: startAt,
      updatedAt: startAt,
      startAt,
      endAt,
    };
  });
}

/** Read release cells back from the (possibly edited) preview slots. */
function previewSlotsToCells(previewSlots: PreviewSlot[]): ReleaseCell[] {
  const cells: ReleaseCell[] = [];
  for (const s of previewSlots) {
    const meta = parseCellId(s.id);
    if (!meta) continue;
    cells.push({
      dayOfWeek: meta.dayOfWeek,
      startTimeMin: meta.startTimeMin,
      durationMin: meta.durationMin,
      price: s.pricePaise,
      blocked: s.status === 'blocked',
    });
  }
  return cells;
}

// ──────────────────────────────────────────────────────────────────────────────
// Page
// ──────────────────────────────────────────────────────────────────────────────

/** Fallback tz while venue is resolving — prevents a crash on first render. */
const FALLBACK_TZ = 'Asia/Kolkata';
const today = new Date().toISOString().slice(0, 10);

/** Default band set offered before any template has been saved. */
const DEFAULT_BANDS: BandRow[] = [{ startTime: '06:00', endTime: '22:00', priceRupees: 500 }];
const DEFAULT_DAY_START = '03:00';

export default function ScheduleBuilderPage() {
  const { arenaId } = useParams<{ arenaId: string }>();
  const tenantId = useSearchParams().get('tenantId') ?? '';

  // ── Resolve venue timezone ──
  const { activeTenantId } = useOrg();
  const { data: arena } = useArena(arenaId);
  const { data: venues } = useVenues(activeTenantId ?? '');
  const tz = venues?.find((v) => v.id === arena?.venueId)?.tzName ?? FALLBACK_TZ;

  // Viewing timezone comes from the portal-wide selector in the top bar. Display
  // only — slots are generated and released in the venue's tz.
  const { resolveTz } = useTimezone();
  const effectiveTz = resolveTz(tz);

  // ── Form state ──
  const [startDate, setStartDate] = useState(today);
  const [endDate, setEndDate] = useState(today);
  const [dayStartTime, setDayStartTime] = useState(DEFAULT_DAY_START);
  const [quantizationMin, setQuantizationMin] = useState(60);
  const [defaultPriceRupees, setDefaultPriceRupees] = useState(500);
  const [bands, setBands] = useState<BandRow[]>(DEFAULT_BANDS);

  // ── Preview / release state ──
  const [previewSlots, setPreviewSlots] = useState<PreviewSlot[] | null>(null);
  const [weekStart, setWeekStart] = useState<Date>(sundayOnOrBefore(today));
  const [validationError, setValidationError] = useState<string | null>(null);
  const releaseSlots = useReleaseSlots(arenaId);
  const [releaseResult, setReleaseResult] = useState<{ created: number; skipped: number } | null>(null);

  // ── Prefill from the arena's saved template (once it first loads) ──
  const prefilledRef = useRef(false);
  useEffect(() => {
    if (prefilledRef.current || !arena) return;
    prefilledRef.current = true;
    setDayStartTime(minToTime(arena.businessDayStartMin));
    const tmpl = arena.scheduleTemplate;
    if (tmpl && tmpl.bands.length > 0) {
      setQuantizationMin(tmpl.quantizationMin);
      setDefaultPriceRupees(tmpl.defaultPriceRupees);
      setBands(
        tmpl.bands.map((b) => ({
          startTime: minToTime(b.startMin),
          endTime: minToTime(b.endMin),
          priceRupees: b.priceRupees,
        })),
      );
    }
  }, [arena]);

  // ── Band-editor helpers ──
  function clearDerived() {
    setPreviewSlots(null);
    setReleaseResult(null);
    setValidationError(null);
  }

  function updateBand(index: number, patch: Partial<BandRow>) {
    setBands((prev) => prev.map((b, i) => (i === index ? { ...b, ...patch } : b)));
    clearDerived();
  }
  function addBand() {
    // Start the new band where the last one ends, for a natural chain.
    const last = bands[bands.length - 1];
    setBands((prev) => [
      ...prev,
      { startTime: last?.endTime ?? '06:00', endTime: last?.endTime ?? '22:00', priceRupees: defaultPriceRupees },
    ]);
    clearDerived();
  }
  function removeBand(index: number) {
    setBands((prev) => prev.filter((_, i) => i !== index));
    clearDerived();
  }

  // ── Build preview ──
  const dayStartMin = parseTimeToMin(dayStartTime);

  function handleBuildPreview() {
    setValidationError(null);
    setReleaseResult(null);

    if (!startDate || !endDate) {
      setValidationError('Start date and End date are required.');
      return;
    }
    if (startDate > endDate) {
      setValidationError('Start date must be on or before End date.');
      return;
    }
    if (Number.isNaN(dayStartMin)) {
      setValidationError('Business day start time is invalid.');
      return;
    }
    const bandModel = rowsToBands(bands);
    const v = validateBands(bandModel, dayStartMin);
    if (!v.ok) {
      setValidationError(v.error ?? 'Bands are invalid.');
      return;
    }

    const cells = expandBandsToCells({ bands: bandModel, dayStartMin, quantizationMin });
    const ws = sundayOnOrBefore(startDate);
    setWeekStart(ws);
    setPreviewSlots(buildPreviewSlots(cells, ws, arenaId));
  }

  // ── Matrix callbacks (edit local preview) ──
  const handleBulk = useCallback((slotIds: string[], patch: { price?: number; blocked?: boolean }) => {
    if (patch.price !== undefined && (Number.isNaN(patch.price) || patch.price < 0)) {
      setValidationError('Per-cell price must be a valid non-negative number (in paise).');
      return;
    }
    setValidationError(null);
    setPreviewSlots((prev) =>
      prev
        ? prev.map((s) => {
            if (!slotIds.includes(s.id)) return s;
            return {
              ...s,
              ...(patch.price !== undefined ? { pricePaise: patch.price } : {}),
              ...(patch.blocked !== undefined
                ? { status: patch.blocked ? ('blocked' as const) : ('open' as const) }
                : {}),
            };
          })
        : prev,
    );
  }, []);

  const handleBook = useCallback((_slotIds: string[]) => {}, []);
  const handlePrevWeek = useCallback(() => {
    setWeekStart((prev) => {
      const d = new Date(prev);
      d.setDate(d.getDate() - 7);
      return d;
    });
  }, []);
  const handleNextWeek = useCallback(() => {
    setWeekStart((prev) => {
      const d = new Date(prev);
      d.setDate(d.getDate() + 7);
      return d;
    });
  }, []);

  // ── Release schedule ──
  async function handleRelease() {
    if (!previewSlots || previewSlots.length === 0) return;
    setReleaseResult(null);

    const template: ScheduleTemplate = {
      quantizationMin,
      defaultPriceRupees,
      bands: rowsToBands(bands).map((b) => ({
        startMin: b.startMin,
        endMin: b.endMin,
        priceRupees: b.priceRupees,
      })),
    };

    try {
      const result = await releaseSlots.mutateAsync({
        startDate,
        endDate,
        quantizationMin,
        cells: previewSlotsToCells(previewSlots),
        businessDayStartMin: dayStartMin,
        template,
      });
      setReleaseResult(result);
    } catch {
      // error surfaced via releaseSlots.error
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Render
  // ──────────────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-6">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Link href="/dashboard" className="hover:underline">
          Dashboard
        </Link>
        <span>/</span>
        <Link href={`/arenas/${arenaId}${tenantId ? `?tenantId=${tenantId}` : ''}`} className="hover:underline">
          Arena
        </Link>
        <span>/</span>
        <span className="text-slate-700 font-medium">Schedule Builder</span>
      </div>

      <h1 className="text-xl font-semibold text-slate-800">Schedule Builder</h1>

      {/* Config form */}
      <Card title="Configure schedule">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Input label="Start date" type="date" value={startDate} onChange={(e) => { setStartDate(e.target.value); clearDerived(); }} />
          <Input label="End date" type="date" value={endDate} onChange={(e) => { setEndDate(e.target.value); clearDerived(); }} />
          <Input
            label="Business day starts at"
            type="time"
            value={dayStartTime}
            hint="Day runs 24h from here"
            onChange={(e) => { setDayStartTime(e.target.value); clearDerived(); }}
          />
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium uppercase tracking-wide text-[#475569]">Quantization</label>
            <select
              value={quantizationMin}
              onChange={(e) => { setQuantizationMin(Number(e.target.value)); clearDerived(); }}
              className="w-full rounded-[var(--radius)] border border-[#e5e7eb] bg-white px-3 py-2 text-sm text-[#0f172a] hover:border-slate-300 transition-colors duration-150"
            >
              <option value={30}>30 min</option>
              <option value={60}>60 min</option>
              <option value={90}>90 min</option>
            </select>
          </div>
        </div>

        {/* Pricing bands */}
        <div className="mt-6">
          <div className="mb-2 flex items-center justify-between">
            <label className="text-xs font-medium uppercase tracking-wide text-[#475569]">Pricing bands</label>
            <span className="text-xs text-slate-400">
              Each band covers a time range at one price. An end ≤ start crosses midnight; set end = start for 24 hours.
            </span>
          </div>

          <div className="flex flex-col gap-2">
            {bands.map((b, i) => (
              <div key={i} className="flex flex-wrap items-end gap-2 rounded-md border border-slate-100 bg-slate-50/60 p-2">
                <Input label={i === 0 ? 'From' : undefined} type="time" value={b.startTime} onChange={(e) => updateBand(i, { startTime: e.target.value })} />
                <span className="pb-2 text-slate-400">→</span>
                <Input label={i === 0 ? 'To' : undefined} type="time" value={b.endTime} onChange={(e) => updateBand(i, { endTime: e.target.value })} />
                <Input
                  label={i === 0 ? 'Price (₹)' : undefined}
                  type="number"
                  min={0}
                  step={1}
                  value={b.priceRupees}
                  onChange={(e) => updateBand(i, { priceRupees: Number(e.target.value) })}
                />
                <Button size="sm" variant="ghost" onClick={() => removeBand(i)} aria-label="Remove band" className="mb-0.5 text-red-500">
                  Remove
                </Button>
              </div>
            ))}
          </div>

          <div className="mt-3">
            <Button onClick={addBand} variant="ghost" size="sm">
              + Add band
            </Button>
          </div>
        </div>

        <div className="mt-4">
          <Button onClick={handleBuildPreview} variant="secondary">
            Generate preview
          </Button>
        </div>

        {validationError && <p className="mt-3 text-sm text-red-600">{validationError}</p>}
      </Card>

      {/* Preview grid */}
      {previewSlots && (
        <>
          <Card
            title="Preview grid"
            subtitle="Drag to select cells, or click a day / time header to toggle a whole column or row. Then set price / block in the inspector panel."
          >
            <div className="mb-4 flex flex-wrap items-center gap-2 rounded-md bg-slate-50 px-3 py-2 text-sm text-slate-600">
              <span className="font-medium">Times shown in</span>
              <span className="rounded border border-slate-200 bg-white px-2 py-0.5 font-mono text-xs text-slate-800">
                {effectiveTz} ({fmtTzOffset(effectiveTz)})
              </span>
              <span className="ml-auto text-xs text-slate-400">Business day starts {dayStartTime}</span>
            </div>

            <Matrix
              mode="builder"
              slots={previewSlots}
              weekStart={weekStart}
              tz={effectiveTz}
              dayStartMin={dayStartMin}
              onBulk={handleBulk}
              onBook={handleBook}
              onPrevWeek={handlePrevWeek}
              onNextWeek={handleNextWeek}
            />
          </Card>

          {/* Release action */}
          <Card title="Release schedule">
            <div className="flex flex-col gap-4">
              <p className="text-sm text-slate-500">
                This will create {quantizationMin}-min slots from{' '}
                <span className="font-medium text-slate-700">{startDate}</span> to{' '}
                <span className="font-medium text-slate-700">{endDate}</span> using the {bands.length} pricing band
                {bands.length === 1 ? '' : 's'} above. Your bands are saved for next time.
              </p>

              {releaseSlots.error && (
                <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">{(releaseSlots.error as Error).message}</p>
              )}

              {releaseResult && (
                <div className="rounded bg-green-50 px-4 py-3 text-sm text-green-800">
                  <p className="font-semibold">Schedule released.</p>
                  <p>
                    Created: <span className="font-mono">{releaseResult.created}</span> &nbsp;|&nbsp; Skipped (already
                    existed): <span className="font-mono">{releaseResult.skipped}</span>
                  </p>
                  <Link
                    href={`/arenas/${arenaId}${tenantId ? `?tenantId=${tenantId}` : ''}`}
                    className="mt-2 inline-block font-medium text-green-700 hover:underline"
                  >
                    Go to reception view →
                  </Link>
                </div>
              )}

              {!releaseResult && (
                <Button
                  variant="primary"
                  loading={releaseSlots.isPending}
                  disabled={releaseSlots.isPending}
                  onClick={() => void handleRelease()}
                >
                  {releaseSlots.isPending ? 'Releasing…' : 'Release schedule'}
                </Button>
              )}
            </div>
          </Card>
        </>
      )}
    </div>
  );
}

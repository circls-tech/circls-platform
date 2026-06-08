'use client';

import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { useState, useCallback } from 'react';
import { Matrix } from '@/components/Matrix';
import { Button, Card, Input } from '@/lib/ui';
import { useArena, useReleaseSlots, useVenues, type ReleaseCell } from '@/lib/api/queries';
import { useOrg } from '@/lib/org_context';
import { useTimezone } from '@/lib/timezone_context';
import { fmtTzOffset } from '@/lib/time';
import type { Slot } from '@/lib/api/types';

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

interface BuilderConfig {
  startDate: string;
  endDate: string;
  dailyOpenTime: string;   // 'HH:MM'
  dailyCloseTime: string;  // 'HH:MM'
  quantizationMin: number;
  defaultPriceRupees: number;
}

type PreviewSlot = Slot;

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

/** Parse 'HH:MM' → minutes from midnight */
function parseTimeToMin(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** Return the Sunday on/before the given YYYY-MM-DD string (local). */
function sundayOnOrBefore(dateStr: string): Date {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() - d.getDay());
  return d;
}

/**
 * Build a synthetic grid of Slot-shaped objects for one representative week.
 *
 * We create an ISO timestamp for each cell by offsetting from Sunday of the
 * preview week. The tz is informational for display; the startAt/endAt values
 * use a simple local-midnight approach (same as the arena page's date picker).
 */
function buildPreviewSlots(cfg: BuilderConfig, arenaId: string, tz: string): PreviewSlot[] {
  const weekStart = sundayOnOrBefore(cfg.startDate);
  const openMin = parseTimeToMin(cfg.dailyOpenTime);
  const closeMin = parseTimeToMin(cfg.dailyCloseTime);
  const { quantizationMin, defaultPriceRupees } = cfg;

  const slots: PreviewSlot[] = [];

  for (let dayOffset = 0; dayOffset < 7; dayOffset++) {
    const dayDate = new Date(weekStart);
    dayDate.setDate(dayDate.getDate() + dayOffset);
    const dayBase = dayDate.getTime(); // midnight local

    for (let minOfDay = openMin; minOfDay < closeMin; minOfDay += quantizationMin) {
      const startMs = dayBase + minOfDay * 60_000;
      const endMs = startMs + quantizationMin * 60_000;
      const startAt = new Date(startMs).toISOString();
      const endAt = new Date(endMs).toISOString();

      slots.push({
        id: `prev-${dayOffset}-${minOfDay}`,
        tenantId: '',
        arenaId,
        timeRange: `[${startAt},${endAt})`,
        pricePaise: defaultPriceRupees * 100,
        status: 'open',
        holdExpiresAt: null,
        bookingId: null,
        releaseId: null,
        deletedAt: null,
        createdAt: startAt,
        updatedAt: startAt,
        startAt,
        endAt,
      });
    }
  }

  return slots;
}

/**
 * Map preview cells to release API cells[].
 * startTimeMin is derived from the slot's startAt (minutes from local midnight).
 */
function buildReleaseCells(previewSlots: PreviewSlot[], quantizationMin: number): ReleaseCell[] {
  return previewSlots.map((slot) => {
    const start = new Date(slot.startAt);
    const hoursMin = start.getHours() * 60 + start.getMinutes();
    // dayOfWeek: 0=Sun … 6=Sat
    const dow = start.getDay();

    return {
      dayOfWeek: dow,
      startTimeMin: hoursMin,
      durationMin: quantizationMin,
      price: slot.pricePaise,
      blocked: slot.status === 'blocked',
    };
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Page
// ──────────────────────────────────────────────────────────────────────────────

/** Fallback tz while venue is resolving — prevents a crash on first render. */
const FALLBACK_TZ = 'Asia/Kolkata';
const today = new Date().toISOString().slice(0, 10);

export default function ScheduleBuilderPage() {
  const { arenaId } = useParams<{ arenaId: string }>();
  const tenantId = useSearchParams().get('tenantId') ?? '';

  // ── Resolve venue timezone ──
  const { activeTenantId } = useOrg();
  const { data: arena } = useArena(arenaId);
  const { data: venues } = useVenues(activeTenantId ?? '');
  const tz = venues?.find((v) => v.id === arena?.venueId)?.tzName ?? FALLBACK_TZ;

  // Viewing timezone comes from the portal-wide selector in the top bar. Auto =
  // the venue's own zone; an override renders the grid in the chosen zone. This
  // is display-only: slots are still generated and released in the venue's tz.
  const { resolveTz } = useTimezone();
  const effectiveTz = resolveTz(tz);

  // Form config state
  const [cfg, setCfg] = useState<BuilderConfig>({
    startDate: today,
    endDate: today,
    dailyOpenTime: '06:00',
    dailyCloseTime: '22:00',
    quantizationMin: 60,
    defaultPriceRupees: 500,
  });

  // Preview grid state
  const [previewSlots, setPreviewSlots] = useState<PreviewSlot[] | null>(null);
  const [weekStart, setWeekStart] = useState<Date>(sundayOnOrBefore(today));
  const [validationError, setValidationError] = useState<string | null>(null);

  // Release mutation
  const releaseSlots = useReleaseSlots(arenaId);
  const [releaseResult, setReleaseResult] = useState<{ created: number; skipped: number } | null>(
    null,
  );

  // ── Config field helpers ──

  function setField<K extends keyof BuilderConfig>(key: K, value: BuilderConfig[K]) {
    setCfg((prev) => ({ ...prev, [key]: value }));
    // Clear preview when config changes
    setPreviewSlots(null);
    setReleaseResult(null);
    setValidationError(null);
  }

  // ── Build preview ──

  function handleBuildPreview() {
    setValidationError(null);
    setReleaseResult(null);

    if (!cfg.startDate || !cfg.endDate) {
      setValidationError('Start date and End date are required.');
      return;
    }
    if (cfg.startDate > cfg.endDate) {
      setValidationError('Start date must be on or before End date.');
      return;
    }
    if (parseTimeToMin(cfg.dailyOpenTime) >= parseTimeToMin(cfg.dailyCloseTime)) {
      setValidationError('Daily open time must be before close time.');
      return;
    }
    // Guard against an empty or NaN default price so `price: NaN` is never sent
    // to the API. The field may be blank if the user clears it.
    if (
      cfg.defaultPriceRupees === undefined ||
      cfg.defaultPriceRupees === null ||
      Number.isNaN(cfg.defaultPriceRupees) ||
      cfg.defaultPriceRupees < 0
    ) {
      setValidationError('Default price must be a valid non-negative number (in ₹).');
      return;
    }

    const ws = sundayOnOrBefore(cfg.startDate);
    setWeekStart(ws);
    setPreviewSlots(buildPreviewSlots(cfg, arenaId, tz));
  }

  // ── Matrix callbacks (edit local preview) ──

  const handleBulk = useCallback(
    (slotIds: string[], patch: { price?: number; blocked?: boolean }) => {
      // Reject a NaN per-cell price before it reaches the preview or the API
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
    },
    [],
  );

  // onBook is a no-op in builder mode
  const handleBook = useCallback((_slotIds: string[]) => {}, []);

  // Nav: just shift the week label (template repeats weekly)
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

    try {
      const cells = buildReleaseCells(previewSlots, cfg.quantizationMin);
      const result = await releaseSlots.mutateAsync({
        startDate: cfg.startDate,
        endDate: cfg.endDate,
        quantizationMin: cfg.quantizationMin,
        cells,
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
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <Input
            label="Start date"
            type="date"
            value={cfg.startDate}
            onChange={(e) => setField('startDate', e.target.value)}
          />
          <Input
            label="End date"
            type="date"
            value={cfg.endDate}
            onChange={(e) => setField('endDate', e.target.value)}
          />
          <Input
            label="Daily open time"
            type="time"
            value={cfg.dailyOpenTime}
            onChange={(e) => setField('dailyOpenTime', e.target.value)}
          />
          <Input
            label="Daily close time"
            type="time"
            value={cfg.dailyCloseTime}
            onChange={(e) => setField('dailyCloseTime', e.target.value)}
          />

          {/* Quantization select */}
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium uppercase tracking-wide text-[#475569]">
              Quantization
            </label>
            <select
              value={cfg.quantizationMin}
              onChange={(e) => setField('quantizationMin', Number(e.target.value))}
              className="w-full rounded-[var(--radius)] border border-[#e5e7eb] bg-white px-3 py-2 text-sm text-[#0f172a] hover:border-slate-300 transition-colors duration-150"
            >
              <option value={30}>30 min</option>
              <option value={60}>60 min</option>
              <option value={90}>90 min</option>
            </select>
          </div>

          <Input
            label="Default price (₹)"
            type="number"
            min={0}
            step={1}
            placeholder="500"
            value={cfg.defaultPriceRupees}
            onChange={(e) => setField('defaultPriceRupees', Number(e.target.value))}
          />
        </div>

        <div className="mt-4">
          <Button onClick={handleBuildPreview} variant="secondary">
            Build preview
          </Button>
        </div>

        {validationError && (
          <p className="mt-3 text-sm text-red-600">{validationError}</p>
        )}
      </Card>

      {/* Preview grid */}
      {previewSlots && (
        <>
          <Card
            title="Preview grid"
            subtitle="Drag to select cells, or click a day / time header to toggle a whole column or row. Then set price / block in the inspector panel."
          >
            {/* Times render in the portal-wide viewing tz (top-bar selector).
                Auto = the venue's own zone. Read-only indicator here. */}
            <div className="mb-4 flex flex-wrap items-center gap-2 rounded-md bg-slate-50 px-3 py-2 text-sm text-slate-600">
              <span className="font-medium">Times shown in</span>
              <span className="rounded border border-slate-200 bg-white px-2 py-0.5 font-mono text-xs text-slate-800">
                {effectiveTz} ({fmtTzOffset(effectiveTz)})
              </span>
              {effectiveTz !== tz && (
                <span className="ml-auto text-xs text-slate-400">
                  Venue is {tz} ({fmtTzOffset(tz)}) · change the zone from the timezone selector in the top bar
                </span>
              )}
            </div>

            <Matrix
              mode="builder"
              slots={previewSlots}
              weekStart={weekStart}
              tz={effectiveTz}
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
                This will create slots from{' '}
                <span className="font-medium text-slate-700">{cfg.startDate}</span> to{' '}
                <span className="font-medium text-slate-700">{cfg.endDate}</span> using the
                template above ({cfg.quantizationMin}-min slots, every day{' '}
                {cfg.dailyOpenTime}–{cfg.dailyCloseTime}).
              </p>

              {releaseSlots.error && (
                <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">
                  {(releaseSlots.error as Error).message}
                </p>
              )}

              {releaseResult && (
                <div className="rounded bg-green-50 px-4 py-3 text-sm text-green-800">
                  <p className="font-semibold">Schedule released.</p>
                  <p>
                    Created: <span className="font-mono">{releaseResult.created}</span> &nbsp;|&nbsp;
                    Skipped (already existed): <span className="font-mono">{releaseResult.skipped}</span>
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

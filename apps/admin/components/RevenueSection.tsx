'use client';

import { useState } from 'react';
import { useAdminRevenue } from '@/lib/api/queries';
import { type CurrencyCode, formatTotal } from '@/lib/money';
import type { RevenueSlice } from '@/lib/api/types';

/**
 * What the platform has sold, as of now.
 *
 * This is the question payouts could not answer: a payout only exists once
 * its week has been reconciled, so an admin asked "how much has this tenant
 * sold so far" had nothing to look at. These figures lead the payout.
 *
 * Both numbers are shown because they answer different questions and get
 * confused for each other: **gross** is what customers paid, **net** is what
 * partners are owed once commission comes out. The gap between them is
 * Circls' own revenue, so it is named rather than left to subtraction.
 */

/** The windows an admin actually asks for, plus a way to pick any other. */
type PresetId = '7d' | '15d' | '30d' | '3m' | '12m' | 'lifetime' | 'custom';

const PRESETS: { id: PresetId; label: string; days: number | null }[] = [
  { id: '7d', label: 'Last 7 days', days: 7 },
  { id: '15d', label: 'Last 15 days', days: 15 },
  { id: '30d', label: 'Last 30 days', days: 30 },
  { id: '3m', label: 'Last 3 months', days: 91 },
  { id: '12m', label: 'Last 12 months', days: 365 },
  { id: 'lifetime', label: 'Lifetime', days: null },
  { id: 'custom', label: 'Custom', days: null },
];

/** A date input's YYYY-MM-DD, `days` ago. */
function daysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

/** Sum a set of slices per currency — never across them. */
function byCurrency(slices: RevenueSlice[]): Map<string, RevenueSlice> {
  const out = new Map<string, RevenueSlice>();
  for (const s of slices) {
    const at = out.get(s.currency);
    if (!at) {
      out.set(s.currency, { ...s, itemType: 'all' });
      continue;
    }
    at.grossPaise += s.grossPaise;
    at.netPaise += s.netPaise;
    at.commissionPaise += s.commissionPaise;
    at.refundsPaise += s.refundsPaise;
    at.bookings += s.bookings;
  }
  return out;
}

/**
 * One card. Gross above, net below, per currency — an org selling in two
 * markets gets two lines rather than one meaningless sum.
 */
function RevenueCard({
  label,
  slices,
  loading,
}: {
  label: string;
  slices: RevenueSlice[];
  loading: boolean;
}) {
  const totals = [...byCurrency(slices).values()].sort((a, b) =>
    a.currency.localeCompare(b.currency),
  );
  const bookings = totals.reduce((n, t) => n + t.bookings, 0);

  return (
    <div className="flex h-full flex-col gap-3 rounded-lg bg-white p-4 ring-1 ring-slate-200">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</span>
        {!loading && (
          <span className="text-xs tabular-nums text-slate-400">
            {bookings} {bookings === 1 ? 'sale' : 'sales'}
          </span>
        )}
      </div>

      {loading ? (
        <div className="space-y-2">
          <div className="h-7 w-28 animate-pulse rounded bg-slate-100" />
          <div className="h-4 w-20 animate-pulse rounded bg-slate-100" />
        </div>
      ) : totals.length === 0 ? (
        <p className="text-sm text-slate-400">Nothing sold</p>
      ) : (
        <div className="space-y-3">
          {totals.map((t) => (
            <div key={t.currency}>
              <div className="text-2xl font-semibold tabular-nums text-slate-900">
                {formatTotal(t.grossPaise, t.currency as CurrencyCode)}
              </div>
              <dl className="mt-1 space-y-0.5 text-xs tabular-nums text-slate-500">
                <div className="flex justify-between gap-3">
                  <dt>Net to partners</dt>
                  <dd className="font-medium text-slate-700">
                    {formatTotal(t.netPaise, t.currency as CurrencyCode)}
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt>Circls commission</dt>
                  <dd>{formatTotal(t.commissionPaise, t.currency as CurrencyCode)}</dd>
                </div>
                {t.refundsPaise > 0 && (
                  <div className="flex justify-between gap-3 text-amber-700">
                    <dt>Refunded</dt>
                    <dd>{formatTotal(t.refundsPaise, t.currency as CurrencyCode)}</dd>
                  </div>
                )}
              </dl>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function RevenueSection() {
  const [preset, setPreset] = useState<PresetId>('30d');
  const [customFrom, setCustomFrom] = useState(daysAgo(30));
  const [customTo, setCustomTo] = useState(new Date().toISOString().slice(0, 10));

  // A date input gives a calendar day; the API wants instants. The end day is
  // inclusive to the reader, so it reaches to the start of the next one.
  const chosen = PRESETS.find((p) => p.id === preset)!;
  const from =
    preset === 'custom'
      ? `${customFrom}T00:00:00.000Z`
      : chosen.days === null
        ? null
        : `${daysAgo(chosen.days)}T00:00:00.000Z`;
  const to = preset === 'custom' ? `${customTo}T23:59:59.999Z` : null;

  const { data, isLoading, isError, error } = useAdminRevenue(from, to);
  const slices = data?.slices ?? [];
  const of = (itemType: string) => slices.filter((s) => s.itemType === itemType);

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xs font-medium uppercase tracking-wide text-slate-500">Revenue</h2>
        <div className="flex flex-wrap items-center gap-2">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => setPreset(p.id)}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                preset === p.id
                  ? 'bg-slate-900 text-white'
                  : 'bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {preset === 'custom' && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
          <label className="flex items-center gap-1.5">
            From
            <input
              type="date"
              value={customFrom}
              max={customTo}
              onChange={(e) => setCustomFrom(e.target.value)}
              className="rounded-md px-2 py-1 ring-1 ring-slate-200"
            />
          </label>
          <label className="flex items-center gap-1.5">
            To
            <input
              type="date"
              value={customTo}
              min={customFrom}
              onChange={(e) => setCustomTo(e.target.value)}
              className="rounded-md px-2 py-1 ring-1 ring-slate-200"
            />
          </label>
        </div>
      )}

      <p className="text-xs text-slate-400">
        Money circls processed, dated when it moved — so a sale appears here
        before it reaches a payout. Desk bookings the partner took directly are
        not included, because circls never handled that money.
      </p>

      {isError ? (
        <p className="text-sm text-red-600">
          Failed to load revenue: {error instanceof Error ? error.message : 'unknown error'}
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <RevenueCard label="All sales" slices={slices} loading={isLoading} />
          <RevenueCard label="Events" slices={of('event')} loading={isLoading} />
          <RevenueCard label="Memberships" slices={of('membership')} loading={isLoading} />
          <RevenueCard label="Venues" slices={of('slot')} loading={isLoading} />
        </div>
      )}
    </section>
  );
}

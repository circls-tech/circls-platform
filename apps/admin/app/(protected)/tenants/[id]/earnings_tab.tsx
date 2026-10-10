'use client';

import { useMemo, useState } from 'react';
import { useAdminTenantEarnings } from '@/lib/api/queries';
import type { EarningsItem, EarningsStream, TenantEarnings } from '@/lib/api/types';
import { type CurrencyCode, formatTotal } from '@/lib/money';
import {
  addCalendarDays,
  calendarDateInTz,
  isCalendarDate,
  rangeBoundsInTz,
} from '@/lib/time';

/**
 * The tenant page's Earnings tab — what Circls owes this organisation, and how
 * much of it has already been sent.
 *
 * A READ-ONLY MIRROR OF THE PARTNER'S OWN PAGE, on purpose. It calls the same
 * service through `/v1/admin/tenants/:id/earnings`, resolves periods with the
 * same calendar maths (lib/time.ts, mirrored from the partners app), and shows
 * the same three streams. The support case this exists for is "my payout looks
 * wrong" — which is only answerable if the admin is looking at the partner's
 * numbers rather than a second, plausibly-different set.
 *
 * So: no gross, no commission, no rate. Not because an admin may not see them —
 * the Payments and Payouts consoles show exactly that — but because this tab's
 * job is to reproduce the partner's view. An admin who needs the gross side has
 * the Billing tab a click away.
 *
 * WHICH DAY A SALE LANDS IN depends on the zone, so the tab names the one it
 * used. It is fixed to the organisation's own timezone rather than the admin's:
 * a partner in Bengaluru querying their Tuesday means Tuesday in Asia/Kolkata,
 * whoever is reading it from where.
 */

// ── Ranges (mirrors the partner page) ────────────────────────────────────────

type RangeKey = 'today' | '7d' | '30d' | 'month' | 'lastMonth' | 'custom';

const RANGE_LABELS: Record<RangeKey, string> = {
  today: 'Today',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  month: 'This month',
  lastMonth: 'Last month',
  custom: 'Custom',
};

const RANGE_ORDER: RangeKey[] = ['today', '7d', '30d', 'month', 'lastMonth', 'custom'];

/** First of the month a 'YYYY-MM-DD' date falls in. */
function firstOfMonth(ymd: string): string {
  return `${ymd.slice(0, 7)}-01`;
}

/**
 * A preset as the pair of calendar dates it covers, inclusive, in `tz`.
 * Resolved on the calendar, not by subtracting hours, so "last 7 days" is
 * seven whole days however long each one was.
 */
function presetDates(key: Exclude<RangeKey, 'custom'>, today: string): { from: string; to: string } {
  switch (key) {
    case 'today':
      return { from: today, to: today };
    case '7d':
      return { from: addCalendarDays(today, -6), to: today };
    case '30d':
      return { from: addCalendarDays(today, -29), to: today };
    case 'month':
      return { from: firstOfMonth(today), to: today };
    case 'lastMonth': {
      const lastDayOfLastMonth = addCalendarDays(firstOfMonth(today), -1);
      return { from: firstOfMonth(lastDayOfLastMonth), to: lastDayOfLastMonth };
    }
  }
}

// ── Streams ──────────────────────────────────────────────────────────────────

const STREAMS: { key: EarningsStream; label: string; unit: string }[] = [
  { key: 'event', label: 'Events', unit: 'registrations' },
  { key: 'membership', label: 'Memberships', unit: 'sign-ups' },
  { key: 'venue', label: 'Venues', unit: 'bookings' },
];

const STREAM_LABEL: Record<EarningsStream, string> = {
  event: 'Event',
  membership: 'Membership plan',
  venue: 'Venue',
};

/** Money in the currency the API reported it in, never guessed from the venue. */
function money(minor: number, currency: string): string {
  return formatTotal(minor, currency as CurrencyCode);
}

function countLabel(n: number, unit: string): string {
  return `${n} ${n === 1 ? unit.replace(/s$/, '') : unit}`;
}

/** The currencies present in a response, in a stable order. */
function currenciesOf(data: TenantEarnings): string[] {
  const seen = new Set<string>();
  for (const t of data.total) seen.add(t.currency);
  for (const d of data.desk) seen.add(d.currency);
  return [...seen].sort();
}

// ── Tab ──────────────────────────────────────────────────────────────────────

export function EarningsTab({ tenantId, tz }: { tenantId: string; tz: string }) {
  const [range, setRange] = useState<RangeKey>('30d');
  const today = calendarDateInTz(new Date(), tz);
  const [customFrom, setCustomFrom] = useState(() => addCalendarDays(today, -29));
  const [customTo, setCustomTo] = useState(today);

  const dates = range === 'custom' ? { from: customFrom, to: customTo } : presetDates(range, today);
  // A cleared date input leaves ''. rangeBoundsInTz throws on anything that is
  // not a calendar date and runs during render, so an unguarded empty field
  // would take the whole tenant page down rather than just skipping the fetch.
  const complete = isCalendarDate(dates.from) && isCalendarDate(dates.to);

  const bounds = useMemo(
    () => (complete ? rangeBoundsInTz(dates.from, dates.to, tz) : null),
    [complete, dates.from, dates.to, tz],
  );

  const { data, isLoading, isError, error } = useAdminTenantEarnings(tenantId, bounds, complete);

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-600">
        What Circls owes this organisation for sales in the period, and how much has already
        been transferred. Every figure is <span className="font-medium">net</span> — the
        partner&apos;s take after commission, fees and refunds — and is exactly what the partner
        sees on their own Earnings page. For gross and commission, use the Billing tab.
      </p>

      {/* Period */}
      <div className="rounded-lg border border-slate-200 p-3">
        <div className="flex flex-wrap gap-2">
          {RANGE_ORDER.map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setRange(key)}
              className={`rounded-md border px-3 py-1.5 text-sm ${
                range === key
                  ? 'border-slate-900 bg-slate-900 font-medium text-white'
                  : 'border-slate-300 text-slate-700 hover:bg-slate-50'
              }`}
            >
              {RANGE_LABELS[key]}
            </button>
          ))}
        </div>

        {range === 'custom' && (
          <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
            <input
              type="date"
              value={customFrom}
              onChange={(e) => setCustomFrom(e.target.value)}
              className="rounded-md border border-slate-300 px-2 py-1"
            />
            <span className="text-slate-500">to</span>
            <input
              type="date"
              value={customTo}
              onChange={(e) => setCustomTo(e.target.value)}
              className="rounded-md border border-slate-300 px-2 py-1"
            />
          </div>
        )}

        <p className="mt-2 text-xs text-slate-500">
          {complete ? `${dates.from} → ${dates.to}` : 'Pick both dates'} · days counted in {tz}
        </p>
      </div>

      {!complete && <p className="text-sm text-slate-500">Pick both dates to see a period.</p>}
      {complete && isLoading && <p className="text-sm text-slate-500">Loading…</p>}
      {complete && isError && (
        <p className="text-sm text-red-700">
          Could not load earnings: {(error as Error)?.message ?? 'unknown error'}
        </p>
      )}

      {complete && data && <EarningsBody data={data} />}

    </div>
  );
}

function EarningsBody({ data }: { data: TenantEarnings }) {
  const currencies = currenciesOf(data);

  if (currencies.length === 0) {
    return <p className="py-2 text-sm text-slate-500">No sales in this period.</p>;
  }

  return (
    <div className="space-y-6">
      {currencies.map((currency) => {
        const total = data.total.find((t) => t.currency === currency);
        const desk = data.desk.find((d) => d.currency === currency);
        const items = data.items.filter((i) => i.currency === currency);

        return (
          <div key={currency} className="space-y-3">
            {/* Multi-currency organisations get one block each; paise and cents
                are never added together. */}
            {currencies.length > 1 && (
              <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                {currency}
              </h3>
            )}

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <SummaryCard
                label="Net payout"
                value={money(total?.netPaise ?? 0, currency)}
                sub={countLabel(total?.bookings ?? 0, 'sales')}
                emphasis
              />
              <SummaryCard
                label="Paid out so far"
                value={money(total?.paidPaise ?? 0, currency)}
                sub="already transferred"
              />
              {STREAMS.map((s) => {
                const row = data.byStream.find(
                  (b) => b.stream === s.key && b.currency === currency,
                );
                if (!row) return null;
                return (
                  <SummaryCard
                    key={s.key}
                    label={s.label}
                    value={money(row.netPaise, currency)}
                    sub={countLabel(row.bookings, s.unit)}
                  />
                );
              })}
              {desk && (
                <SummaryCard
                  label="Collected at their desk"
                  value={money(desk.amountMinor, currency)}
                  sub={`${countLabel(desk.bookings, 'bookings')} · not part of any payout`}
                />
              )}
            </div>

            {total && total.netPaise < 0 && (
              <p className="text-sm text-amber-700">
                Refunds outran sales in this period, so the net reads negative. That is a real
                figure, not an error — it carries into the payout cycle.
              </p>
            )}

            <ItemTable items={items} />
          </div>
        );
      })}
    </div>
  );
}

function SummaryCard({
  label,
  value,
  sub,
  emphasis,
}: {
  label: string;
  value: string;
  sub?: string;
  emphasis?: boolean;
}) {
  return (
    <div
      className={`rounded-lg border p-3 ${
        emphasis ? 'border-slate-900 bg-slate-50' : 'border-slate-200'
      }`}
    >
      <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`mt-1 font-semibold ${emphasis ? 'text-xl' : 'text-lg'} text-slate-900`}>
        {value}
      </div>
      {sub && <div className="mt-0.5 text-xs text-slate-500">{sub}</div>}
    </div>
  );
}

function ItemTable({ items }: { items: EarningsItem[] }) {
  if (items.length === 0) {
    return <p className="py-2 text-sm text-slate-500">Nothing in this period.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
            <th className="px-2 py-2 font-semibold">Name</th>
            <th className="px-2 py-2 font-semibold">Type</th>
            <th className="px-2 py-2 text-right font-semibold">Sales</th>
            <th className="px-2 py-2 text-right font-semibold">Net payout</th>
            <th className="px-2 py-2 text-right font-semibold">Paid out</th>
          </tr>
        </thead>
        <tbody>
          {items.map((i) => (
            <tr
              key={`${i.stream}-${i.id ?? 'none'}-${i.currency}`}
              className="border-b border-slate-100"
            >
              <td className="px-2 py-2">
                <span className="font-medium text-slate-800">
                  {i.name ?? <span className="italic text-slate-500">Unattributed</span>}
                </span>
                {i.venueName && <span className="block text-xs text-slate-500">{i.venueName}</span>}
              </td>
              <td className="px-2 py-2 text-slate-600">{STREAM_LABEL[i.stream]}</td>
              <td className="px-2 py-2 text-right text-slate-600">{i.bookings}</td>
              <td
                className={`px-2 py-2 text-right font-medium ${
                  i.netPaise < 0 ? 'text-amber-700' : 'text-slate-800'
                }`}
              >
                {money(i.netPaise, i.currency)}
              </td>
              {/* Nothing sent yet is the normal state for a recent window, so it
                  reads as a dash rather than a zero that looks like a shortfall. */}
              <td className="px-2 py-2 text-right text-slate-600">
                {i.paidPaise === 0 ? (
                  <span className="text-slate-400">—</span>
                ) : (
                  money(i.paidPaise, i.currency)
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

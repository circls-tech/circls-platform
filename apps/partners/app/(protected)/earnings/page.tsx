'use client';

import { useMemo, useState } from 'react';
import { useEarnings } from '@/lib/api/queries';
import type { EarningsItem, EarningsStream, TenantEarnings } from '@/lib/api/types';
import { asCurrencyCode, formatMoney } from '@/lib/currency';
import { downloadCsv, toCsv } from '@/lib/csv';
import { useOrg } from '@/lib/org_context';
import {
  addCalendarDays,
  calendarDateInTz,
  canonicalTz,
  isCalendarDate,
  rangeBoundsInTz,
} from '@/lib/time';
import { useTimezone } from '@/lib/timezone_context';
import { Button, Card, Input } from '@/lib/ui';
import { useCan } from '@/lib/use_can';

/**
 * Earnings — what Circls will actually pay the organisation for a chosen period.
 *
 * EVERY FIGURE ON THIS PAGE IS NET: the money that reaches the partner once
 * Circls' commission and the gateway's fees are out. That is the whole reason
 * the page exists. Before it, a partner wanting this number had to open each
 * event and add up a registrations column that shows the customer's full bill —
 * a figure larger than even their gross, since it also carries the consumer-side
 * commission and the customer's share of the gateway fee.
 *
 * So: no gross anywhere, and no "before/after" comparison. The API doesn't
 * return the gross either (see apps/api/src/services/earnings_service.ts), so
 * there is nothing here that could drift back into showing a partner money that
 * isn't theirs to keep.
 *
 * DATED BY WHEN THE CUSTOMER PAID, not by when a payout settles — so a sale made
 * today counts today. The money then arrives on the weekly payout cycle set out
 * in the Partner Terms, which is why the page says "will be paid" rather than
 * "has been paid".
 *
 * Money is grouped per currency and never summed across them: an organisation
 * selling in both India and the USA gets an INR block and a USD block rather
 * than a meaningless paise+cents total.
 */

// ── Ranges ────────────────────────────────────────────────────────────────────

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
 *
 * Presets are resolved on the calendar rather than by subtracting hours, so
 * "last 7 days" is seven whole days however long each one was — the same reason
 * `addCalendarDays` exists.
 */
function presetDates(key: Exclude<RangeKey, 'custom'>, today: string): { from: string; to: string } {
  switch (key) {
    case 'today':
      return { from: today, to: today };
    case '7d':
      // Inclusive of today, so six days back — not seven.
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

// ── Streams ───────────────────────────────────────────────────────────────────

const STREAMS: { key: EarningsStream; label: string; unit: string; petal: string }[] = [
  { key: 'event', label: 'Events', unit: 'registrations', petal: '#9CE0D4' },
  { key: 'membership', label: 'Memberships', unit: 'sign-ups', petal: '#F9B4D4' },
  { key: 'venue', label: 'Venues', unit: 'bookings', petal: '#BCE3A0' },
];

const STREAM_LABEL: Record<EarningsStream, string> = {
  event: 'Event',
  membership: 'Membership plan',
  venue: 'Venue',
};

type TabKey = 'all' | EarningsStream;

// ── Presentation helpers ──────────────────────────────────────────────────────

/** Money, in the currency the API reported it in. */
function money(paise: number, currency: string): string {
  return formatMoney(paise, asCurrencyCode(currency), { decimals: 2 });
}

/** "3 registrations" / "1 registration". */
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

// ── Page ──────────────────────────────────────────────────────────────────────

export default function EarningsPage() {
  const { activeTenantId, tenants } = useOrg();
  const activeTenant = tenants.find((t) => t.id === activeTenantId);
  const { resolveTz } = useTimezone();
  // Org-wide page, so there is no single venue tz to follow: the viewer's
  // chosen zone, else their browser's. Which day a late-evening sale lands in
  // depends on it, so the page says which zone it used.
  const tz = resolveTz(null);

  // Owners, Managers and Read-only members. Staff run the desk but don't see
  // financial reports — see ROLE_INFO in lib/roles.ts.
  const canRead = useCan('financials.read');

  const [range, setRange] = useState<RangeKey>('7d');
  const today = calendarDateInTz(new Date(), tz);
  const [customFrom, setCustomFrom] = useState(() => addCalendarDays(today, -6));
  const [customTo, setCustomTo] = useState(today);
  const [tab, setTab] = useState<TabKey>('all');

  const dates = range === 'custom' ? { from: customFrom, to: customTo } : presetDates(range, today);
  // A date input can be cleared, which leaves `''`. Both dates must be real
  // before any of this is a period: rangeBoundsInTz rejects anything else, and
  // it is computed during render, so an unguarded empty field takes the whole
  // page down rather than just failing the fetch.
  const complete = isCalendarDate(dates.from) && isCalendarDate(dates.to);

  // Not named `window` — that shadows the global in a client component.
  const bounds = useMemo(
    () => (complete ? rangeBoundsInTz(dates.from, dates.to, tz) : null),
    [complete, dates.from, dates.to, tz],
  );

  const { data, isLoading, isError, error } = useEarnings(
    activeTenantId ?? null,
    bounds,
    canRead && bounds !== null,
  );

  function exportCsv() {
    if (!data || !complete) return;
    const rows = data.items.map((i) => [
      STREAM_LABEL[i.stream],
      i.name ?? 'Unattributed',
      i.venueName ?? '',
      i.bookings,
      i.currency,
      (i.netPaise / 100).toFixed(2),
    ]);
    downloadCsv(
      toCsv(['Type', 'Name', 'Venue', 'Bookings', 'Currency', 'Net payout'], rows),
      `earnings-${dates.from}-to-${dates.to}.csv`,
    );
  }

  const header = (
    <div>
      <h1 className="font-[family-name:var(--font-display)] text-2xl font-extrabold tracking-tight text-[#17151D]">
        Earnings
      </h1>
      {activeTenant && (
        <p className="mt-0.5 text-sm font-semibold text-[#EE5C2B]">{activeTenant.name}</p>
      )}
    </div>
  );

  if (!activeTenantId) {
    return (
      <div className="flex flex-col gap-4">
        {header}
        <Card subtitle="Select or create an organisation first to see its earnings.">
          <p className="text-sm text-slate-500">No active organisation.</p>
        </Card>
      </div>
    );
  }

  // Not RoleNotice: that reports suspension as the reason, and a suspended
  // organisation CAN still see what it is owed — only Staff cannot.
  if (!canRead) {
    return (
      <div className="flex flex-col gap-4">
        {header}
        <Card>
          <p className="py-2 text-sm text-slate-600">
            Earnings are visible to Owners, Managers and Read-only members. Ask an Owner or Manager
            if you need access to financial reports.
          </p>
        </Card>
      </div>
    );
  }

  const shown =
    tab === 'all' ? (data?.items ?? []) : (data?.items ?? []).filter((i) => i.stream === tab);
  const currencies = data ? currenciesOf(data) : [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        {header}
        {data && data.items.length > 0 && (
          <Button size="sm" variant="secondary" onClick={exportCsv}>
            Export CSV
          </Button>
        )}
      </div>

      {/* ── What the numbers mean. Stated up front, because a partner who has
          only ever seen gross will otherwise read these as the same figure
          they get elsewhere and conclude something is missing. ── */}
      <Card>
        <p className="text-sm text-slate-600">
          Every amount here is your <strong className="text-[#17151D]">net payout</strong> — what
          reaches you after Circls&rsquo; commission and payment-gateway charges, and after any
          refunds. It is not the total your customers were charged. Sales count on the day the
          customer paid; the money itself is transferred on the weekly payout cycle in your{' '}
          <a href="/terms" className="font-semibold text-[#EE5C2B] underline">
            Partner Terms
          </a>
          .
        </p>
      </Card>

      {/* ── Range picker ── */}
      <Card>
        <div className="flex flex-wrap items-center gap-2">
          {RANGE_ORDER.map((key) => (
            <Button
              key={key}
              size="sm"
              variant={range === key ? 'primary' : 'secondary'}
              {...(range === key ? { petal: '#FCE38A' } : {})}
              onClick={() => setRange(key)}
            >
              {RANGE_LABELS[key]}
            </Button>
          ))}
        </div>
        {range === 'custom' && (
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <Input
              label="From"
              type="date"
              value={customFrom}
              max={customTo}
              onChange={(e) => setCustomFrom(e.target.value)}
            />
            <Input
              label="To"
              type="date"
              value={customTo}
              min={customFrom}
              onChange={(e) => setCustomTo(e.target.value)}
            />
          </div>
        )}
        <p className="mt-3 text-xs text-slate-500">
          {complete ? (
            <>
              {dates.from === dates.to ? dates.from : `${dates.from} → ${dates.to}`} · days counted
              in {canonicalTz(tz)}
            </>
          ) : (
            'Pick both a start and an end date.'
          )}
        </p>
      </Card>

      {isError && (
        <Card>
          <p className="py-2 text-sm text-red-700">
            Couldn&rsquo;t load earnings{error instanceof Error ? `: ${error.message}` : '.'}
          </p>
        </Card>
      )}

      {isLoading && (
        <Card>
          <p className="py-2 text-sm text-slate-500">Adding up your earnings…</p>
        </Card>
      )}

      {data && !isLoading && (
        <>
          {currencies.length === 0 ? (
            <Card>
              <p className="py-2 text-sm text-slate-500">
                No sales in this period. Try a wider range.
              </p>
            </Card>
          ) : (
            currencies.map((currency) => (
              <CurrencyBlock key={currency} currency={currency} data={data} />
            ))
          )}

          {/* ── Per-item detail ── */}
          {data.items.length > 0 && (
            <Card
              title="Every event, plan and venue"
              subtitle="Net payout for each one, so you can see where the money came from."
            >
              <div className="mb-3 flex flex-wrap gap-2">
                {(['all', ...STREAMS.map((s) => s.key)] as TabKey[]).map((key) => {
                  const label = key === 'all' ? 'All' : STREAMS.find((s) => s.key === key)!.label;
                  const count =
                    key === 'all'
                      ? data.items.length
                      : data.items.filter((i) => i.stream === key).length;
                  return (
                    <Button
                      key={key}
                      size="sm"
                      variant={tab === key ? 'primary' : 'secondary'}
                      {...(tab === key ? { petal: '#A9C9F2' } : {})}
                      disabled={count === 0 && key !== 'all'}
                      onClick={() => setTab(key)}
                    >
                      {label} ({count})
                    </Button>
                  );
                })}
              </div>
              <ItemTable items={shown} />
            </Card>
          )}
        </>
      )}
    </div>
  );
}

// ── Sub-views ─────────────────────────────────────────────────────────────────

/**
 * One currency's totals: the headline net, each stream's share, and desk cash.
 *
 * Desk takings sit apart from the total on purpose. That money never went
 * through Circls, so it can never be in a payout — but the Dashboard's Revenue
 * tile does count it, and a partner comparing the two pages deserves to see why
 * they differ rather than assume one is wrong.
 */
function CurrencyBlock({ currency, data }: { currency: string; data: TenantEarnings }) {
  const total = data.total.find((t) => t.currency === currency);
  const desk = data.desk.find((d) => d.currency === currency);
  const multi = new Set(data.total.map((t) => t.currency)).size > 1;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Net payout{multi ? ` · ${currency}` : ''}
            </p>
            <p className="mt-1 font-[family-name:var(--font-display)] text-3xl font-extrabold tracking-tight text-[#17151D]">
              {money(total?.netPaise ?? 0, currency)}
            </p>
          </div>
          {total && total.bookings > 0 && (
            <p className="text-sm text-slate-500">
              from {countLabel(total.bookings, 'sales')} through Circls
            </p>
          )}
        </div>
        {total && total.netPaise < 0 && (
          <p className="mt-3 text-sm text-amber-700">
            Refunds in this period came to more than the sales in it. The difference is settled
            against a later payout.
          </p>
        )}
      </Card>

      <div className="grid gap-4 sm:grid-cols-3">
        {STREAMS.map((s) => {
          const row = data.byStream.find((b) => b.stream === s.key && b.currency === currency);
          return (
            <Card key={s.key}>
              <div
                className="mb-2 h-1.5 w-8 rounded-full"
                style={{ backgroundColor: s.petal }}
                aria-hidden
              />
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                {s.label}
              </p>
              <p className="mt-1 font-[family-name:var(--font-display)] text-xl font-extrabold text-[#17151D]">
                {money(row?.netPaise ?? 0, currency)}
              </p>
              <p className="mt-0.5 text-xs text-slate-500">{countLabel(row?.bookings ?? 0, s.unit)}</p>
            </Card>
          );
        })}
      </div>

      {desk && desk.amountMinor > 0 && (
        <Card>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Collected at your desk{multi ? ` · ${currency}` : ''}
              </p>
              <p className="mt-1 font-[family-name:var(--font-display)] text-xl font-extrabold text-[#17151D]">
                {money(desk.amountMinor, currency)}
              </p>
            </div>
            <p className="max-w-md text-xs text-slate-500">
              You took this directly from {countLabel(desk.bookings, 'customers')}, so it is already
              yours and is <strong>not</strong> part of the net payout above.
            </p>
          </div>
        </Card>
      )}
    </div>
  );
}

function ItemTable({ items }: { items: EarningsItem[] }) {
  if (items.length === 0) {
    return <p className="py-2 text-sm text-slate-500">Nothing in this period.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b-2 border-[#17151D] text-left text-xs uppercase tracking-wide text-slate-500">
            <th className="px-2 py-2 font-semibold">Name</th>
            <th className="px-2 py-2 font-semibold">Type</th>
            <th className="px-2 py-2 text-right font-semibold">Sales</th>
            <th className="px-2 py-2 text-right font-semibold">Net payout</th>
          </tr>
        </thead>
        <tbody>
          {items.map((i) => (
            <tr key={`${i.stream}-${i.id ?? 'none'}-${i.currency}`} className="border-b border-slate-200">
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
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

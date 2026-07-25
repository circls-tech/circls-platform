'use client';

import { useMemo, useState } from 'react';
import { useActivityDaily, useActivityFeed, useMembershipWindows } from '@/lib/api/activity';
import { useVenues } from '@/lib/api/queries';
import type { ActivityItem, ActivityItemType, MembershipWindowItem } from '@/lib/api/types';
import { downloadCsv, toCsv } from '@/lib/csv';
import { formatMoney, useVenueCurrencies } from '@/lib/currency';
import { Badge, BadgeTone, Button, Card, Input } from '@/lib/ui';
import { useOrg } from '@/lib/org_context';
import { useTimezone } from '@/lib/timezone_context';

// ──────────────────────────────────────────────────────────────────────────────
// Formatting helpers
// ──────────────────────────────────────────────────────────────────────────────

function fmtInTz(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: tz,
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

function fmtTimeInTz(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

function fmtDateInTz(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: tz,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(new Date(iso));
}

/** Today's calendar date in `tz` as 'YYYY-MM-DD'. */
function todayInTz(tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

const TYPE_META: Record<ActivityItemType, { label: string; tone: BadgeTone }> = {
  slot: { label: 'Booking', tone: 'booked' },
  event: { label: 'Event', tone: 'held' },
  membership: { label: 'Membership', tone: 'success' },
};

const STATUS_META: Record<string, { label: string; tone: BadgeTone }> = {
  pending: { label: 'Pending', tone: 'warning' },
  confirmed: { label: 'Confirmed', tone: 'success' },
  completed: { label: 'Completed', tone: 'booked' },
  cancelled: { label: 'Cancelled', tone: 'danger' },
  no_show: { label: 'No-show', tone: 'neutral' },
};

function StatusBadge({ status }: { status: string }) {
  const meta = STATUS_META[status] ?? { label: status, tone: 'neutral' as BadgeTone };
  return <Badge tone={meta.tone} label={meta.label} />;
}

// ──────────────────────────────────────────────────────────────────────────────
// Month calendar — per-day booking counts, green when the day has bookings
// ──────────────────────────────────────────────────────────────────────────────

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// UTC so the label of Date.UTC(y, m-1, 1) never bleeds into the prior month.
const MONTH_LABEL = new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function BookingsCalendar({
  month,
  onMonthChange,
  counts,
  today,
  selectedDate,
  onSelectDate,
}: {
  month: string; // 'YYYY-MM'
  onMonthChange: (m: string) => void;
  counts: Map<string, number>;
  today: string; // 'YYYY-MM-DD'
  selectedDate: string | null;
  onSelectDate: (date: string | null) => void;
}) {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  // Monday-first offset of the 1st (getUTCDay: 0 = Sunday).
  const leadingBlanks = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7;

  const cells: (number | null)[] = [
    ...Array.from({ length: leadingBlanks }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];

  return (
    <div>
      {/* Month switcher */}
      <div className="mb-3 flex items-center justify-between">
        <Button variant="ghost" size="sm" onClick={() => onMonthChange(shiftMonth(month, -1))} aria-label="Previous month">
          &larr;
        </Button>
        <span className="text-sm font-semibold text-[#0f172a]">
          {MONTH_LABEL.format(new Date(Date.UTC(y, m - 1, 1)))}
        </span>
        <Button variant="ghost" size="sm" onClick={() => onMonthChange(shiftMonth(month, 1))} aria-label="Next month">
          &rarr;
        </Button>
      </div>

      <div className="grid grid-cols-7 gap-1">
        {WEEKDAYS.map((d) => (
          <div key={d} className="pb-1 text-center text-[11px] font-medium text-slate-400">
            {d}
          </div>
        ))}
        {cells.map((day, i) => {
          if (day === null) return <div key={`blank-${i}`} />;
          const date = `${month}-${String(day).padStart(2, '0')}`;
          const count = counts.get(date) ?? 0;
          const isToday = date === today;
          const isSelected = date === selectedDate;
          return (
            <button
              key={date}
              type="button"
              onClick={() => onSelectDate(isSelected ? null : date)}
              title={`${count} booking${count === 1 ? '' : 's'}`}
              className={[
                'flex h-14 flex-col items-center justify-center rounded-md border text-sm transition-colors',
                count > 0
                  ? 'border-green-200 bg-green-50 text-green-900 hover:bg-green-100'
                  : 'border-transparent text-slate-600 hover:bg-slate-50',
                isSelected ? 'ring-2 ring-brand-500' : '',
              ].join(' ')}
            >
              <span className={['leading-none', isToday ? 'flex h-5 w-5 items-center justify-center rounded-full bg-[#0f172a] text-[11px] font-semibold text-white' : ''].join(' ')}>
                {day}
              </span>
              <span className={['mt-1 text-[11px] leading-none', count > 0 ? 'font-semibold text-green-700' : 'text-transparent'].join(' ')}>
                {count > 0 ? count : '·'}
              </span>
            </button>
          );
        })}
      </div>
      <p className="mt-2 text-xs text-slate-400">
        Days with confirmed sessions are green; the number is that day&rsquo;s booking count. Click a
        day to see its bookings below.
      </p>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Membership start/end panel
// ──────────────────────────────────────────────────────────────────────────────

function MembershipWindowList({
  items,
  kind,
  tz,
  today,
}: {
  items: MembershipWindowItem[];
  kind: 'starting' | 'ending';
  tz: string;
  today: string;
}) {
  if (items.length === 0) {
    return (
      <p className="py-3 text-sm text-slate-400">
        No memberships {kind === 'starting' ? 'starting' : 'ending'} around now.
      </p>
    );
  }
  return (
    <ul className="divide-y divide-[#f1f5f9]">
      {items.map((mw) => {
        const anchorIso = kind === 'starting' ? mw.startsAt : mw.endsAt;
        const anchorDate = new Intl.DateTimeFormat('en-CA', {
          timeZone: tz,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        }).format(new Date(anchorIso));
        const inPast = anchorDate < today;
        return (
          <li key={`${kind}-${mw.userMembershipId}`} className="flex items-center justify-between gap-3 py-2.5">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-slate-800">
                {mw.buyerName ?? mw.buyerContact ?? 'Member'}
              </p>
              <p className="truncate text-xs text-slate-500">
                {mw.membershipName}
                {mw.tierName ? ` · ${mw.tierName}` : ''}
              </p>
            </div>
            <div className="shrink-0 text-right">
              <p className={['text-xs font-medium', kind === 'ending' && !inPast ? 'text-amber-700' : 'text-slate-600'].join(' ')}>
                {kind === 'starting'
                  ? (inPast ? 'Started ' : 'Starts ') + fmtDateInTz(mw.startsAt, tz)
                  : (inPast ? 'Ended ' : 'Ends ') + fmtDateInTz(mw.endsAt, tz)}
              </p>
              <p className="text-[11px] text-slate-400">
                {fmtDateInTz(mw.startsAt, tz)} &ndash; {fmtDateInTz(mw.endsAt, tz)}
              </p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Page
// ──────────────────────────────────────────────────────────────────────────────

export default function ActivityPage() {
  const { activeTenantId } = useOrg();
  const tenantId = activeTenantId ?? '';
  const { resolveTz } = useTimezone();
  const tz = resolveTz();
  const today = todayInTz(tz);
  // Per-row display currency: rows span venues, which may settle in different
  // currencies (venue country → currency; tenant country for org-wide rows).
  const { currencyFor } = useVenueCurrencies();

  // Calendar state
  const [month, setMonth] = useState(() => todayInTz(resolveTz()).slice(0, 7));
  const [selectedDate, setSelectedDate] = useState<string | null>(null);

  // Feed filters
  const [typeFilter, setTypeFilter] = useState<'' | ActivityItemType>('');
  const [venueFilter, setVenueFilter] = useState('');
  const [fromFilter, setFromFilter] = useState('');
  const [toFilter, setToFilter] = useState('');
  const [qFilter, setQFilter] = useState('');

  const { data: venues } = useVenues(tenantId);
  const { data: dailyCounts } = useActivityDaily(tenantId, month, tz, venueFilter || undefined);
  const membershipWindows = useMembershipWindows(tenantId);

  const feedParams = {
    ...(typeFilter ? { type: typeFilter } : {}),
    ...(venueFilter ? { venueId: venueFilter } : {}),
    ...(fromFilter ? { from: new Date(fromFilter).toISOString() } : {}),
    ...(toFilter ? { to: new Date(toFilter).toISOString() } : {}),
    ...(qFilter ? { q: qFilter } : {}),
    ...(selectedDate ? { sessionDate: selectedDate, tz } : {}),
  };
  const feed = useActivityFeed(tenantId, feedParams);
  const rows: ActivityItem[] = feed.data?.pages.flatMap((p) => p.rows) ?? [];

  const countsByDate = useMemo(
    () => new Map((dailyCounts ?? []).map((d) => [d.date, d.bookings])),
    [dailyCounts],
  );

  const hasFilters = Boolean(typeFilter || venueFilter || fromFilter || toFilter || qFilter || selectedDate);

  function clearFilters() {
    setTypeFilter('');
    setVenueFilter('');
    setFromFilter('');
    setToFilter('');
    setQFilter('');
    setSelectedDate(null);
  }

  function exportCsv() {
    // The feed spans venues, so amounts carry an explicit per-row currency
    // column instead of a single-symbol header (a US + India org is mixed).
    const headers = ['When', 'Customer', 'Contact', 'Type', 'Item', 'Tier', 'Venue', 'Starts', 'Ends', 'Status', 'Channel', 'Total', 'Currency'];
    const data = rows.map((r) => [
      fmtInTz(r.createdAt, tz),
      r.customerName ?? '',
      r.customerContact ?? '',
      TYPE_META[r.itemType].label,
      r.itemName ?? '',
      r.tierName ?? '',
      r.venueName ?? '',
      r.startAt ? fmtInTz(r.startAt, tz) : '',
      r.endAt ? fmtInTz(r.endAt, tz) : '',
      r.status,
      r.channel,
      r.totalPaise == null ? '' : (r.totalPaise / 100).toFixed(2),
      r.totalPaise == null ? '' : currencyFor(r.venueId),
    ]);
    downloadCsv(toCsv(headers, data), `activity-${today}.csv`);
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-[family-name:var(--font-display)] text-3xl font-extrabold tracking-tight text-[#17151D]">Activity</h1>
        <p className="mt-0.5 font-[family-name:var(--font-accent)] text-xl font-bold text-[#EE5C2B]">
          Everything happening across your organisation — bookings, event registrations and
          membership purchases.
        </p>
      </div>

      {/* Calendar + membership windows */}
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Bookings calendar" subtitle="How busy each day is, at a glance.">
          <BookingsCalendar
            month={month}
            onMonthChange={setMonth}
            counts={countsByDate}
            today={today}
            selectedDate={selectedDate}
            onSelectDate={setSelectedDate}
          />
        </Card>

        <Card
          title="Memberships starting & ending"
          subtitle="Validity windows opening or closing within 30 days."
        >
          {membershipWindows.isLoading && (
            <p className="py-6 text-center text-sm text-slate-400">Loading&hellip;</p>
          )}
          {membershipWindows.isError && (
            <p className="py-6 text-center text-sm text-red-500">Failed to load memberships.</p>
          )}
          {membershipWindows.data && (
            <div className="flex flex-col gap-4">
              <div>
                <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Starting
                </h3>
                <MembershipWindowList
                  items={membershipWindows.data.starting}
                  kind="starting"
                  tz={tz}
                  today={today}
                />
              </div>
              <div>
                <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Ending
                </h3>
                <MembershipWindowList
                  items={membershipWindows.data.ending}
                  kind="ending"
                  tz={tz}
                  today={today}
                />
              </div>
            </div>
          )}
        </Card>
      </div>

      {/* Feed */}
      <Card
        title="Recent activity"
        subtitle="Who booked what, newest first."
      >
        {/* Filters */}
        <div className="mb-4 flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-slate-500">Type</label>
            <select
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value as '' | ActivityItemType)}
              className="rounded border border-[#e5e7eb] bg-white px-2 py-1.5 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-brand-500"
            >
              <option value="">All types</option>
              <option value="slot">Bookings</option>
              <option value="event">Events</option>
              <option value="membership">Memberships</option>
            </select>
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-slate-500">Venue</label>
            <select
              value={venueFilter}
              onChange={(e) => setVenueFilter(e.target.value)}
              className="rounded border border-[#e5e7eb] bg-white px-2 py-1.5 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-brand-500"
            >
              <option value="">All venues</option>
              {(venues ?? []).map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-slate-500">From</label>
            <input
              type="datetime-local"
              value={fromFilter}
              onChange={(e) => setFromFilter(e.target.value)}
              className="rounded border border-[#e5e7eb] bg-white px-2 py-1.5 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-slate-500">To</label>
            <input
              type="datetime-local"
              value={toFilter}
              onChange={(e) => setToFilter(e.target.value)}
              className="rounded border border-[#e5e7eb] bg-white px-2 py-1.5 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </div>

          <div className="flex w-52 flex-col gap-1">
            <label className="text-xs font-medium text-slate-500">Customer</label>
            <Input
              value={qFilter}
              onChange={(e) => setQFilter(e.target.value)}
              placeholder="Name or contact"
            />
          </div>

          {hasFilters && (
            <Button variant="ghost" size="sm" onClick={clearFilters}>
              Clear
            </Button>
          )}

          <div className="ml-auto">
            <Button variant="secondary" size="sm" onClick={exportCsv} disabled={rows.length === 0}>
              Download CSV
            </Button>
          </div>
        </div>

        {/* Selected-day chip */}
        {selectedDate && (
          <div className="mb-3">
            <Badge
              tone="success"
              label={`Sessions on ${fmtDateInTz(`${selectedDate}T12:00:00Z`, 'UTC')} — click the day again to clear`}
            />
          </div>
        )}

        {feed.isLoading && <p className="py-6 text-center text-sm text-slate-400">Loading&hellip;</p>}
        {feed.isError && (
          <p className="py-6 text-center text-sm text-red-500">Failed to load activity.</p>
        )}
        {!feed.isLoading && !feed.isError && rows.length === 0 && (
          <p className="py-6 text-center text-sm text-slate-400">No activity found.</p>
        )}

        {!feed.isLoading && !feed.isError && rows.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#e5e7eb] text-left">
                  <th className="pb-2 pr-4 font-medium text-slate-500">When</th>
                  <th className="pb-2 pr-4 font-medium text-slate-500">Customer</th>
                  <th className="pb-2 pr-4 font-medium text-slate-500">Type</th>
                  <th className="pb-2 pr-4 font-medium text-slate-500">Item</th>
                  <th className="pb-2 pr-4 font-medium text-slate-500">Venue</th>
                  <th className="pb-2 pr-4 font-medium text-slate-500">Scheduled</th>
                  <th className="pb-2 pr-4 font-medium text-slate-500">Status</th>
                  <th className="pb-2 text-right font-medium text-slate-500">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#f1f5f9]">
                {rows.map((r) => (
                  <tr key={r.id} className="align-top">
                    <td className="py-2.5 pr-4 text-xs text-slate-500 whitespace-nowrap">
                      {fmtInTz(r.createdAt, tz)}
                    </td>
                    <td className="py-2.5 pr-4">
                      <span className="text-slate-800">
                        {r.customerName ?? <span className="text-slate-400">—</span>}
                      </span>
                      {r.customerContact && (
                        <p className="text-xs text-slate-400">{r.customerContact}</p>
                      )}
                    </td>
                    <td className="py-2.5 pr-4">
                      <Badge tone={TYPE_META[r.itemType].tone} label={TYPE_META[r.itemType].label} />
                    </td>
                    <td className="py-2.5 pr-4 text-slate-700">
                      {r.itemName ?? <span className="text-slate-400">—</span>}
                      {r.tierName && <p className="text-xs text-slate-400">{r.tierName}</p>}
                    </td>
                    <td className="py-2.5 pr-4 text-slate-600">
                      {r.venueName ?? <span className="text-slate-400">—</span>}
                    </td>
                    <td className="py-2.5 pr-4 text-xs text-slate-600 whitespace-nowrap">
                      {r.itemType === 'membership' && r.startAt && r.endAt ? (
                        <>
                          {fmtDateInTz(r.startAt, tz)} &ndash; {fmtDateInTz(r.endAt, tz)}
                        </>
                      ) : r.startAt && r.endAt ? (
                        <>
                          {fmtInTz(r.startAt, tz)} &ndash; {fmtTimeInTz(r.endAt, tz)}
                        </>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </td>
                    <td className="py-2.5 pr-4">
                      <StatusBadge status={r.status} />
                    </td>
                    <td className="py-2.5 text-right text-slate-800 whitespace-nowrap">
                      {r.totalPaise == null ? (
                        <span className="text-slate-400">—</span>
                      ) : (
                        formatMoney(r.totalPaise, currencyFor(r.venueId))
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {feed.hasNextPage && (
          <div className="mt-4 flex justify-center">
            <Button
              variant="secondary"
              size="sm"
              loading={feed.isFetchingNextPage}
              onClick={() => void feed.fetchNextPage()}
            >
              Load more
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}

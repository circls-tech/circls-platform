'use client';
import Link from 'next/link';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useArenas, useMe, useMyTenants, useVenues, useAnalytics } from '@/lib/api/queries';
import { useTenantEvents } from '@/lib/api/events';
import { useMemberships } from '@/lib/api/memberships';
import { ReceptionButton } from '@/components/ReceptionButton';
import { useTimezone } from '@/lib/timezone_context';
import { useOrg } from '@/lib/org_context';
import {
  type CurrencyCode,
  asCurrencyCode,
  formatMoney,
  useCurrency,
  useVenueCurrencies,
} from '@/lib/currency';
import { planSummary } from '@/lib/plan_summary';
import { isEventOnShelf, isMembershipOnShelf, isVenueOnShelf } from '@/lib/shelf';
import { useCan } from '@/lib/use_can';
import { Card, StatusPill } from '@/lib/ui';
import type {
  AnalyticsTrendDay,
  Membership,
  MoneyByCurrency,
  Venue,
  VenueEventSummary,
} from '@/lib/api/types';

/** The dashboard's own "add" link — same shape wherever a section offers one. */
const ADD_LINK_CLASS =
  'inline-flex items-center justify-center gap-2 rounded-[var(--radius)] border-2 border-[#17151D] ' +
  'bg-[#FFD2A1] px-3 py-1.5 text-xs font-bold text-[#17151D] shadow-[3px_3px_0_#17151D] ' +
  'transition-transform hover:-translate-y-0.5';

/** A section's card. A plain div, never a Link: these carry their own buttons,
 *  and a button inside a link is a nested control the keyboard can't reach. */
const TILE_CLASS =
  'flex flex-col gap-2 rounded-[var(--radius)] border-2 border-[#17151D] bg-white p-5 ' +
  'shadow-[4px_4px_0_#17151D]';

// ── Stat Card ─────────────────────────────────────────────────────────────────

interface StatCardProps {
  label: string;
  value: string;
  sublabel: string;
  loading?: boolean;
  /** Navigator-petal pastel behind the icon chip (brand sheet). */
  petal: string;
  /** Stroke icon in the chip; 'currency' renders ₹ or $ per the org currency. */
  icon: 'calendar' | 'currency' | 'trend' | 'chart';
}

function StatIcon({ name, currency, size = 20 }: { name: StatCardProps['icon']; currency: CurrencyCode; size?: number }) {
  const common = {
    xmlns: 'http://www.w3.org/2000/svg',
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };
  switch (name) {
    case 'calendar':
      return (
        <svg {...common}>
          <rect x="3" y="4" width="18" height="18" rx="2" />
          <line x1="16" y1="2" x2="16" y2="6" />
          <line x1="8" y1="2" x2="8" y2="6" />
          <line x1="3" y1="10" x2="21" y2="10" />
        </svg>
      );
    case 'currency':
      return currency === 'USD' ? (
        <svg {...common}>
          <line x1="12" y1="2" x2="12" y2="22" />
          <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
        </svg>
      ) : (
        <svg {...common}>
          <path d="M6 3h12" />
          <path d="M6 8h12" />
          <path d="m6 13 8.5 8" />
          <path d="M6 13h3" />
          <path d="M9 13c6.667 0 6.667-10 0-10" />
        </svg>
      );
    case 'trend':
      return (
        <svg {...common}>
          <polyline points="22 7 13.5 15.5 8.5 10.5 2 17" />
          <polyline points="16 7 22 7 22 13" />
        </svg>
      );
    case 'chart':
      return (
        <svg {...common}>
          <line x1="6" y1="20" x2="6" y2="16" />
          <line x1="12" y1="20" x2="12" y2="10" />
          <line x1="18" y1="20" x2="18" y2="4" />
        </svg>
      );
  }
}

function StatCard({ label, value, sublabel, loading, petal, icon }: StatCardProps) {
  const currency = useCurrency();
  return (
    <Card className="h-full">
      <div className="flex h-full flex-col justify-between gap-4">
        <div className="flex items-center gap-2.5">
          <span
            aria-hidden
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border-2 border-[#17151D] text-[#17151D]"
            style={{ backgroundColor: petal }}
          >
            <StatIcon name={icon} currency={currency} size={13} />
          </span>
          <p className="font-[family-name:var(--font-body)] text-xs font-semibold text-slate-600">{label}</p>
        </div>
        {loading ? (
          <div className="h-7 w-16 animate-pulse rounded-md bg-slate-100" />
        ) : (
          <p className="font-[family-name:var(--font-display)] text-2xl font-extrabold tracking-tight text-[#17151D]">{value}</p>
        )}
        <p className="font-[family-name:var(--font-body)] text-[11px] text-slate-500">{sublabel}</p>
      </div>
    </Card>
  );
}

// ── 7-day Trend Chart ─────────────────────────────────────────────────────────

/**
 * Money taken per day over the week. A day can be negative — refunds are
 * dated when they were made, not backdated onto the sale — so the chart has a
 * baseline with bars hanging below it. Both directions share one scale, and
 * the two halves are only as tall as the data needs, so a week with no refunds
 * looks exactly as it did before.
 */
function TrendChart({ trend, currency }: { trend: AnalyticsTrendDay[]; currency: CurrencyCode }) {
  const MAX_BAR_HEIGHT_PX = 96; // h-24
  const MIN_BAR_HEIGHT_PX = 6; // min visible for a non-zero day

  const maxTaken = Math.max(...trend.map((d) => d.revenuePaise), 0);
  const maxGivenBack = Math.max(...trend.map((d) => -d.revenuePaise), 0);
  const scale = Math.max(maxTaken, maxGivenBack);

  /** Format 'YYYY-MM-DD' → short weekday or day number */
  function dayLabel(date: string): string {
    const d = new Date(`${date}T00:00:00`);
    // Use abbreviated weekday so bars are clearly labelled
    return d.toLocaleDateString('en-IN', { weekday: 'short' });
  }

  if (scale === 0) {
    return <p className="text-sm text-slate-400 py-2">Nothing taken in the last 7 days yet.</p>;
  }

  const px = (amount: number) =>
    Math.max(MIN_BAR_HEIGHT_PX, Math.round((Math.abs(amount) / scale) * MAX_BAR_HEIGHT_PX));
  // Each half is sized from its own extreme, but never smaller than the bar it
  // has to hold: a ₹1 refund against a ₹1,000 week rounds to no height at all,
  // and the day would vanish rather than read as the small loss it was.
  const half = (extreme: number) => (extreme === 0 ? 0 : px(extreme));
  const abovePx = half(maxTaken);
  const belowPx = half(maxGivenBack);

  return (
    <div className="flex gap-3 pt-2">
      {trend.map((day) => {
        const taken = day.revenuePaise;
        const tooltipText = `${dayLabel(day.date)}: ${formatMoney(taken, currency)} · ${day.bookings} booking${day.bookings === 1 ? '' : 's'}`;

        return (
          <div key={day.date} className="flex flex-1 flex-col items-center gap-1">
            <span className="h-3 font-[family-name:var(--font-display)] text-[11px] font-bold leading-none text-[#17151D]">
              {taken !== 0 ? formatMoney(taken, currency) : ''}
            </span>

            {/* Taken: grows up from the baseline. */}
            <div
              className="flex w-full flex-col justify-end"
              style={{ height: `${abovePx}px` }}
            >
              {taken > 0 && (
                <div
                  className="w-full rounded-t-md border-2 border-[#17151D] bg-brand-600 transition-all hover:bg-brand-700"
                  style={{ height: `${px(taken)}px` }}
                  title={tooltipText}
                />
              )}
            </div>

            {/* The baseline, and on a day that took nothing it is also the
                only thing to hover: free registrations still have a count
                worth reading, and a day whose refunds cancelled its sales
                should say so rather than look like no day at all. */}
            {taken === 0 ? (
              <div
                className="w-full border-t-2 border-[#17151D] py-0.5"
                title={tooltipText}
              />
            ) : (
              <div className="w-full border-t-2 border-[#17151D]" />
            )}

            {/* Given back: hangs below it. Absent entirely in a week with no
                refunds, so the chart keeps its usual shape. */}
            {belowPx > 0 && (
              <div
                className="flex w-full flex-col justify-start"
                style={{ height: `${belowPx}px` }}
              >
                {taken < 0 && (
                  <div
                    className="w-full rounded-b-md border-2 border-t-0 border-[#17151D] bg-[#FFB0A3] transition-all"
                    style={{ height: `${px(taken)}px` }}
                    title={tooltipText}
                  />
                )}
              </div>
            )}

            <span className="text-[10px] font-semibold leading-none text-[#17151D]">
              {dayLabel(day.date)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ── Sections: venues, events, memberships ───────────────────────────────

/** Shared empty state: one sentence, and the way to fix it. */
function EmptySection({
  message,
  addHref,
  addLabel,
  canAdd,
}: {
  message: string;
  addHref: string;
  addLabel: string;
  canAdd: boolean;
}) {
  // Ink, not grey: this is the only thing in the section, and the one
  // instruction a partner with nothing yet needs to read. The gap goes on this
  // inner wrapper because Card puts its children inside a padding div of its
  // own — a flex class on Card itself only ever sees that one child.
  // Sized to its content, not to the grid: a full-width card holding one short
  // sentence read as a section that had failed to load.
  return (
    <Card className="w-fit max-w-full">
      <div className="flex flex-col items-start gap-4">
        <p className="text-sm font-medium text-[#17151D]">{message}</p>
        {canAdd && (
          <Link href={addHref} className={ADD_LINK_CLASS}>
            {addLabel}
          </Link>
        )}
      </div>
    </Card>
  );
}

/**
 * The first few, and the way to the rest.
 *
 * The dashboard is glanced at, so no section may grow without bound: an org
 * with forty plans would push everything under it off the page.
 */
const SECTION_LIMIT = 6;

function MoreLink({ href, count, noun }: { href: string; count: number; noun: string }) {
  return (
    <Link href={href} className="text-xs font-semibold text-[#EE5C2B] hover:underline">
      All {count} {noun} →
    </Link>
  );
}

/**
 * A section with rows, all of them off shelf, must not claim there are none at
 * all: that reads as data loss to a partner who can see them on the list page.
 * It says what is there and where, rather than counting what it is hiding.
 */
function sectionEmptyMessage(total: number, none: string, allOffShelf: string): string {
  return total === 0 ? none : allOffShelf;
}

function SectionSpinner({ what }: { what: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-slate-500">
      <span className="block h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-slate-600" />
      Loading {what}…
    </div>
  );
}

/**
 * One venue, with the way into its desk.
 *
 * A venue has no single desk — reception is run per arena — so the button
 * only points straight at a grid when there is exactly one arena to mean. With
 * several it goes to the venue, where each arena carries its own button; that
 * is one extra click, and honest, rather than guessing which court is meant.
 *
 * Every arena counts, whatever its listing status. Nothing in the walk-in path
 * checks it, and the venue page offers reception on every row — so filtering
 * to `active` here hid a working desk from exactly the partner most likely to
 * want it: one who has just created a venue and whose arenas await review.
 */
function VenueTile({ venue, tenantId }: { venue: Venue; tenantId: string }) {
  const { data: arenas } = useArenas(venue.id);
  const desks = arenas ?? [];
  const deskHref =
    desks.length === 1
      ? `/arenas/${desks[0]!.id}?tenantId=${tenantId}`
      : `/venues/${venue.id}?tenantId=${tenantId}`;

  return (
    <div className={TILE_CLASS}>
      <div className="flex items-start justify-between gap-2">
        <Link
          href={`/venues/${venue.id}?tenantId=${tenantId}`}
          className="font-[family-name:var(--font-display)] font-bold text-[#17151D] hover:underline"
        >
          {venue.name}
        </Link>
        <StatusPill
          status={venue.status}
          {...(venue.status === 'suspended' ? { label: 'Closed' } : {})}
        />
      </div>
      {/* min-h holds the row at the button's height, so the meta line sits at
          the same place on every card whether or not it has one. */}
      <div className="flex min-h-8 items-center justify-between gap-2">
        <p className="text-xs text-slate-400">
          {desks.length > 0
            ? `${desks.length} ${desks.length === 1 ? 'arena' : 'arenas'}`
            : 'No arenas yet'}
        </p>
        {desks.length > 0 && <ReceptionButton href={deskHref} />}
      </div>
    </div>
  );
}

function VenuesSection({ tenantId }: { tenantId: string }) {
  const { data: venues, isLoading } = useVenues(tenantId);
  const canAddVenue = useCan('venues.write', tenantId);

  if (isLoading) return <SectionSpinner what="venues" />;

  // Closed and rejected venues are off shelf: not on the consumer portal, so
  // not on the surface for what is running now. They stay on /venues.
  const onShelf = (venues ?? []).filter(isVenueOnShelf);

  if (onShelf.length === 0) {
    return (
      <EmptySection
        message={sectionEmptyMessage(
          venues?.length ?? 0,
          `No venues yet.${canAddVenue ? ' Add your first venue to get started.' : ''}`,
          'No venues open right now. Your closed and rejected ones are on the Venues page.',
        )}
        addHref="/venues"
        addLabel="＋ Add venue"
        canAdd={canAddVenue}
      />
    );
  }

  const shown = onShelf.slice(0, SECTION_LIMIT);

  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {shown.map((venue) => (
          <VenueTile key={venue.id} venue={venue} tenantId={tenantId} />
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3 pt-1">
        {canAddVenue && (
          <Link href="/venues" className={ADD_LINK_CLASS}>
            ＋ Add venue
          </Link>
        )}
        {onShelf.length > shown.length && (
          <MoreLink href="/venues" count={onShelf.length} noun="venues" />
        )}
      </div>
    </div>
  );
}

/**
 * Events get no Reception button, on purpose.
 *
 * A venue's desk is a calendar because its inventory is a calendar: a court is
 * sold in slots across the day. An event is one moment with a guest list, so
 * the equivalent is that list — and it only matters on the day. So the tile
 * carries the date instead, and says plainly when the event is today.
 */
function EventTile({ event, tenantId, tz }: { event: VenueEventSummary; tenantId: string; tz: string }) {
  const starts = new Date(event.startsAt);
  const fmt = new Intl.DateTimeFormat('en-IN', {
    timeZone: tz,
    day: '2-digit',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
  const dayOf = (d: Date) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d);
  const isToday = dayOf(starts) === dayOf(new Date());

  return (
    <div className={TILE_CLASS}>
      <div className="flex items-start justify-between gap-2">
        <Link
          href={`/events/${event.id}?tenantId=${tenantId}`}
          className="font-[family-name:var(--font-display)] font-bold text-[#17151D] hover:underline"
        >
          {event.name}
        </Link>
        <StatusPill status={event.status} />
      </div>
      <p className="text-xs text-slate-400">
        {isToday ? (
          <span className="font-bold text-[#EE5C2B]">Today, {fmt.format(starts).split(', ').pop()}</span>
        ) : (
          fmt.format(starts)
        )}
      </p>
    </div>
  );
}

function EventsSection({ tenantId }: { tenantId: string }) {
  const { data: events, isLoading } = useTenantEvents(tenantId);
  const canAddEvent = useCan('events.write', tenantId);
  const { resolveTz } = useTimezone();
  const tz = resolveTz();

  if (isLoading) return <SectionSpinner what="events" />;

  // Cancelled and rejected events are off shelf. The API's default shelf only
  // drops what the partner has archived by hand, so an event pulled a minute
  // ago would otherwise sit at the top of the dashboard.
  const onShelf = (events ?? []).filter(isEventOnShelf);

  if (onShelf.length === 0) {
    return (
      <EmptySection
        message={sectionEmptyMessage(
          events?.length ?? 0,
          `No events yet.${canAddEvent ? ' Create one to start taking registrations.' : ''}`,
          'No events running right now. Your cancelled and rejected ones are on the Events page.',
        )}
        addHref="/events/new"
        addLabel="＋ New event"
        canAdd={canAddEvent}
      />
    );
  }

  // What is coming, soonest first — then the most recent of what has been.
  // Sorting on the date alone put a fortnight-old event at the front, which is
  // the opposite of quick access.
  const now = new Date().toISOString();
  const upcoming = onShelf
    .filter((e) => e.endsAt >= now)
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  const past = onShelf
    .filter((e) => e.endsAt < now)
    .sort((a, b) => b.startsAt.localeCompare(a.startsAt));
  const shown = [...upcoming, ...past].slice(0, SECTION_LIMIT);

  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {shown.map((event) => (
          <EventTile key={event.id} event={event} tenantId={tenantId} tz={tz} />
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3 pt-1">
        {canAddEvent && (
          <Link href="/events/new" className={ADD_LINK_CLASS}>
            ＋ New event
          </Link>
        )}
        {onShelf.length > shown.length && (
          <MoreLink href="/events" count={onShelf.length} noun="events" />
        )}
      </div>
    </div>
  );
}

function MembershipsSection({ tenantId }: { tenantId: string }) {
  const { data: plans, isLoading } = useMemberships(tenantId);
  const canAddPlan = useCan('memberships.write', tenantId);
  const { currencyFor } = useVenueCurrencies();

  if (isLoading) return <SectionSpinner what="memberships" />;

  // Deactivated and rejected plans are off shelf; they stay on /memberships.
  const onShelf = (plans ?? []).filter(isMembershipOnShelf);

  if (onShelf.length === 0) {
    return (
      <EmptySection
        message={sectionEmptyMessage(
          plans?.length ?? 0,
          `No membership plans yet.${canAddPlan ? ' Create one to start selling.' : ''}`,
          'No plans on sale right now. Your deactivated and rejected ones are on the Memberships page.',
        )}
        addHref="/memberships/new"
        addLabel="＋ New plan"
        canAdd={canAddPlan}
      />
    );
  }

  const shown = onShelf.slice(0, SECTION_LIMIT);

  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {shown.map((plan) => (
          <div key={plan.id} className={TILE_CLASS}>
            <div className="flex items-start justify-between gap-2">
              <Link
                href={`/memberships/${plan.id}?tenantId=${tenantId}`}
                className="font-[family-name:var(--font-display)] font-bold text-[#17151D] hover:underline"
              >
                {plan.name}
              </Link>
              <StatusPill status={plan.status} />
            </div>
            {/* Same min-h as the venue tile, so the meta line keeps its place
                whatever sits beside it. */}
            <div className="flex min-h-8 items-center justify-between gap-2">
              <p className="text-xs text-slate-400">
                {planSummary(plan, currencyFor(plan.venueId))}
              </p>
              {/* Straight to the walk-in form, open on arrival: a plan has one
                  desk, so unlike a venue there is nothing to disambiguate. */}
              <ReceptionButton href={`/memberships/${plan.id}?tenantId=${tenantId}&desk=1`} />
            </div>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3 pt-1">
        {canAddPlan && (
          <Link href="/memberships/new" className={ADD_LINK_CLASS}>
            ＋ New plan
          </Link>
        )}
        {onShelf.length > shown.length && (
          <MoreLink href="/memberships" count={onShelf.length} noun="plans" />
        )}
      </div>
    </div>
  );
}

// ── Dashboard Page ────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const router = useRouter();
  const { data: me } = useMe();
  const { data: tenants, isLoading } = useMyTenants();
  const { activeTenantId, tenants: orgTenants } = useOrg();

  // Revenue is money actually taken — captured payments less refunds, plus
  // what the partner took at the desk — dated by when it moved, so these tiles
  // reconcile with the Activity feed. Days are still cut on IST midnight
  // whatever the venue's timezone: multi-venue timezone support is a known
  // deferred limitation, and would need the backend to take a tz parameter and
  // aggregate per venue. Revenue IS bucketed per currency, read off each
  // payment: an org selling in both the US and India gets one bucket and one
  // trend series per currency.
  const { data: analytics, isLoading: analyticsLoading } = useAnalytics(
    activeTenantId ?? '',
  );
  const currency = useCurrency();

  // Redirect new users who have no org yet to the onboarding wizard.
  useEffect(() => {
    if (!isLoading && tenants !== undefined && tenants.length === 0) {
      router.replace('/onboarding');
    }
  }, [isLoading, tenants, router]);

  const activeTenant = orgTenants.find((t) => t.id === activeTenantId) ?? null;
  const identity = me?.displayName ?? me?.phoneE164 ?? me?.email ?? null;

  // Derived stat values (safe for zero state). Revenue buckets are per
  // currency — usually one; a mixed-currency org shows "₹1,200 · $50".
  const fmtBuckets = (buckets: MoneyByCurrency[] | undefined): string =>
    !buckets || buckets.length === 0
      ? formatMoney(0, currency)
      : buckets.map((b) => formatMoney(b.amountMinor, asCurrencyCode(b.currency))).join(' · ');
  const bookingsToday = analytics?.bookingsToday ?? 0;
  const revenueToday = fmtBuckets(analytics?.revenueToday);

  return (
    <div className="flex flex-col gap-8">
      {/* ── Header ── */}
      <div className="flex flex-col gap-1">
        <h1 className="font-[family-name:var(--font-display)] text-2xl font-extrabold tracking-tight text-[#17151D]">
          Good to see you{activeTenant ? `, ${activeTenant.name}` : ''}
        </h1>
        {identity && (
          <p className="text-sm font-semibold text-[#EE5C2B]">Signed in as {identity}</p>
        )}
      </div>

      {/* ── Stat Cards ── */}
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-bold uppercase tracking-widest text-[#EE5C2B]">
          Overview
        </h2>
        {/* Two cards, not four. The week-scale pair — revenue and occupancy
            over 7 days — said little a partner acts on today, and the chart
            below already carries the week. */}
        <div className="grid gap-4 sm:grid-cols-2">
          <StatCard
            label="Bookings today"
            value={String(bookingsToday)}
            sublabel="Booked today — courts, events and memberships"
            loading={analyticsLoading && Boolean(activeTenantId)}
            petal="#FCE38A"
            icon="calendar"
          />
          <StatCard
            label="Revenue today"
            value={revenueToday}
            sublabel="Taken today, less refunds made today"
            loading={analyticsLoading && Boolean(activeTenantId)}
            petal="#FFB0A3"
            icon="currency"
          />
        </div>
      </section>

      {/* ── 7-day trend chart ── */}
      {activeTenantId && (
        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-bold uppercase tracking-widest text-[#EE5C2B]">
            Last 7 days
          </h2>
          <Card title="Revenue trend">
            {analyticsLoading ? (
              <div className="flex items-end gap-2 h-32 pt-2">
                {Array.from({ length: 7 }).map((_, i) => (
                  <div
                    key={i}
                    className="flex flex-1 flex-col items-center gap-1"
                  >
                    <div
                      className="w-full animate-pulse rounded-t-sm bg-slate-100"
                      style={{ height: `${24 + (i % 3) * 24}px` }}
                    />
                    <div className="h-2 w-6 animate-pulse rounded bg-slate-100" />
                  </div>
                ))}
              </div>
            ) : analytics && analytics.trend7d.length === 0 ? (
              <p className="text-sm text-slate-400 py-2">No bookings in the last 7 days yet.</p>
            ) : analytics ? (
              // One chart per currency with revenue — usually exactly one.
              <div className="flex flex-col gap-4">
                {analytics.trend7d.map((series) => (
                  <div key={series.currency}>
                    {analytics.trend7d.length > 1 && (
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                        {series.currency}
                      </p>
                    )}
                    <TrendChart trend={series.days} currency={asCurrencyCode(series.currency)} />
                  </div>
                ))}
              </div>
            ) : null}
          </Card>
        </section>
      )}

      {/* ── What you run: one section per kind, each with its desk and its
             "add" — so the things done daily are reachable from the page
             everyone lands on, not three clicks into a tab. ── */}
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-bold uppercase tracking-widest text-[#EE5C2B]">
          Your Venues
        </h2>

        {!activeTenantId ? (
          <Card className="flex flex-col items-start gap-3">
            <p className="text-sm text-slate-500">
              No organisation selected. Pick or create one to see venues.
            </p>
            <Link
              href="/onboarding"
              className="inline-flex items-center justify-center gap-2 rounded-[var(--radius)] border-2 border-[#17151D] bg-[#FFD2A1] px-3 py-1.5 text-xs font-bold text-[#17151D] shadow-[3px_3px_0_#17151D] transition-transform hover:-translate-y-0.5"
            >
              Set up organisation
            </Link>
          </Card>
        ) : (
          <VenuesSection tenantId={activeTenantId} />
        )}
      </section>

      {activeTenantId && (
        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-bold uppercase tracking-widest text-[#EE5C2B]">
            Your Events
          </h2>
          <EventsSection tenantId={activeTenantId} />
        </section>
      )}

      {activeTenantId && (
        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-bold uppercase tracking-widest text-[#EE5C2B]">
            Your Memberships
          </h2>
          <MembershipsSection tenantId={activeTenantId} />
        </section>
      )}
    </div>
  );
}

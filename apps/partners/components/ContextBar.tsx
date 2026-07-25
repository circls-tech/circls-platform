'use client';
import Link from 'next/link';
import { useRef } from 'react';
import { useParams, usePathname, useRouter } from 'next/navigation';
import { useOrg } from '@/lib/org_context';
import { useVenues, useArenas, useArena } from '@/lib/api/queries';

// ── shared chevron svgs ────────────────────────────────────────────────────────

function ChevronDown() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-slate-400"
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-brand-900 shrink-0"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function ChevronRight() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-slate-300"
    >
      <polyline points="9 6 15 12 9 18" />
    </svg>
  );
}

// ── Segment: a single dropdown in the breadcrumb ──────────────────────────────

interface SegmentItem {
  id: string;
  name: string;
}

interface SegmentProps {
  label: string;       // display name (or placeholder)
  loading?: boolean;
  items: SegmentItem[];
  currentId: string | null;
  onSelect: (id: string) => void;
  addNewHref?: string;
  addNewLabel?: string;
}

function Segment({ label, loading, items, currentId, onSelect, addNewHref, addNewLabel }: SegmentProps) {
  const detailsRef = useRef<HTMLDetailsElement>(null);

  function handleSelect(id: string) {
    onSelect(id);
    if (detailsRef.current) detailsRef.current.open = false;
  }

  // If there are no siblings and not loading, still show the label as plain text (no dropdown)
  if (items.length === 0 && !loading) {
    return (
      <span className="text-sm font-medium text-slate-500 px-3 py-1.5 select-none">
        {label}
      </span>
    );
  }

  return (
    <details ref={detailsRef} className="relative">
      <summary
        className="flex cursor-pointer list-none items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100 select-none"
        style={{ outline: 'none' }}
      >
        <span className={['max-w-[160px] truncate', loading ? 'text-slate-400' : ''].join(' ')}>
          {label}
        </span>
        <ChevronDown />
      </summary>

      <div className="absolute left-0 top-full z-50 mt-1 w-52 rounded-md border border-[#e5e7eb] bg-white shadow-md">
        <ul className="py-1">
          {items.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => handleSelect(item.id)}
                className={[
                  'flex w-full items-center gap-2 px-4 py-2 text-left text-sm transition-colors',
                  item.id === currentId
                    ? 'bg-slate-50 font-medium text-slate-900'
                    : 'text-slate-700 hover:bg-slate-50',
                ].join(' ')}
              >
                <span className="flex-1 truncate">{item.name}</span>
                {item.id === currentId && <CheckIcon />}
              </button>
            </li>
          ))}
        </ul>
        {addNewHref && (
          <div className="border-t border-[#e5e7eb] py-1">
            <Link
              href={addNewHref}
              onClick={() => { if (detailsRef.current) detailsRef.current.open = false; }}
              className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm font-medium text-brand-900 hover:bg-slate-50"
            >
              <span className="text-base leading-none">＋</span>
              {addNewLabel ?? 'Add new'}
            </Link>
          </div>
        )}
      </div>
    </details>
  );
}


// ── Org switcher (comic style) ────────────────────────────────────────────────

/** Petal pastels cycled per org for the initial chips. */
const ORG_PETALS = ['#BCE3A0', '#CDBBF7', '#A9C9F2', '#F9B4D4', '#FFB0A3', '#FCE38A', '#9CE0D4', '#FFD2A1'] as const;

function OrgInitial({ name, color, className = '' }: { name: string; color: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={`flex shrink-0 items-center justify-center rounded-lg border-2 border-slate-900 font-bold text-slate-900 ${className}`}
      style={{ backgroundColor: color }}
    >
      {name.trim().charAt(0).toUpperCase() || '?'}
    </span>
  );
}

function OrgSwitcher({
  tenants,
  currentId,
  subtitle,
  onSelect,
}: {
  tenants: SegmentItem[];
  currentId: string | null;
  subtitle: string | null;
  onSelect: (id: string) => void;
}) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  // A stale/unknown currentId falls back to the first org so the trigger never
  // renders empty; selection state in the menu still keys off currentId itself.
  const currentIdx = Math.max(0, tenants.findIndex((t) => t.id === currentId));
  const current = tenants[currentIdx];
  const petalFor = (i: number) => ORG_PETALS[i % ORG_PETALS.length];

  function handleSelect(id: string) {
    onSelect(id);
    if (detailsRef.current) detailsRef.current.open = false;
  }

  return (
    <details ref={detailsRef} className="relative">
      <summary
        className="flex cursor-pointer list-none items-center gap-2.5 rounded-xl py-1.5 pl-1 pr-2 select-none hover:bg-white/60"
        style={{ outline: 'none' }}
      >
        <OrgInitial name={current?.name ?? '?'} color={petalFor(currentIdx)} className="h-8 w-8 text-sm" />
        <span className="flex min-w-0 flex-col leading-tight">
          <span className="max-w-[180px] truncate text-sm font-bold text-slate-900">{current?.name ?? '…'}</span>
          {subtitle && <span className="text-xs text-slate-500">{subtitle}</span>}
        </span>
        <ChevronDown />
      </summary>

      <div className="absolute left-0 top-full z-50 mt-2 w-64 rounded-2xl border-2 border-slate-900 bg-white p-1.5 shadow-[4px_4px_0_#0f172a]">
        <ul className="flex flex-col gap-0.5">
          {tenants.map((t, i) => (
            <li key={t.id}>
              <button
                type="button"
                onClick={() => handleSelect(t.id)}
                className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left text-sm font-semibold text-slate-900 hover:bg-slate-50"
                style={t.id === currentId ? { backgroundColor: `${petalFor(i)}40` } : undefined}
              >
                <OrgInitial name={t.name} color={petalFor(i)} className="h-8 w-8 text-sm" />
                <span className="flex-1 truncate">{t.name}</span>
              </button>
            </li>
          ))}
        </ul>
        <div className="mx-2 my-1.5 border-t border-slate-200" />
        <Link
          href="/onboarding"
          onClick={() => { if (detailsRef.current) detailsRef.current.open = false; }}
          className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left text-sm font-semibold text-slate-900 hover:bg-slate-50"
        >
          <span
            aria-hidden
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border-2 border-slate-900 bg-[#FAF3E8] text-base font-bold text-slate-900"
          >
            +
          </span>
          Add organisation
        </Link>
      </div>
    </details>
  );
}

// ── Separator ─────────────────────────────────────────────────────────────────

function Separator() {
  return (
    <span className="flex items-center text-slate-300 select-none">
      <ChevronRight />
    </span>
  );
}

// ── Route-depth detection ─────────────────────────────────────────────────────

type RouteDepth = 'org' | 'venue' | 'arena';

function useRouteDepth(): { depth: RouteDepth; venueId: string | null; arenaId: string | null } {
  const pathname = usePathname();
  const params = useParams();

  // Arena routes: /arenas/[arenaId] and /arenas/[arenaId]/schedule
  if (pathname.includes('/arenas/')) {
    const arenaId = typeof params.arenaId === 'string' ? params.arenaId : null;
    return { depth: 'arena', venueId: null, arenaId };
  }

  // Venue routes: /venues/[venueId] and /venues/[venueId]/bookings
  if (pathname.match(/\/venues\/[^/]+/)) {
    const venueId = typeof params.venueId === 'string' ? params.venueId : null;
    return { depth: 'venue', venueId, arenaId: null };
  }

  // Everything else: dashboard, /venues (list), /settings, /onboarding, /tenants/...
  return { depth: 'org', venueId: null, arenaId: null };
}

// ── ContextBar ────────────────────────────────────────────────────────────────

export function ContextBar() {
  const router = useRouter();
  const { activeTenantId, setActiveTenantId, tenants } = useOrg();
  const { depth, venueId: paramVenueId, arenaId: paramArenaId } = useRouteDepth();

  // ── Arena-level data ──────────────────────────────────────────────────────
  // Hooks must be unconditional; use enabled/null to gate fetches.
  const { data: arena, isLoading: arenaLoading } = useArena(
    depth === 'arena' ? paramArenaId : null,
  );

  // Once arena resolves we know its venueId; for venue routes we use the param directly.
  const resolvedVenueId: string | null =
    depth === 'venue' ? paramVenueId :
    depth === 'arena' ? (arena?.venueId ?? null) :
    null;

  const { data: venues = [], isLoading: venuesLoading } = useVenues(activeTenantId ?? '');
  const { data: arenas = [], isLoading: arenasLoading } = useArenas(resolvedVenueId ?? '');

  // ── Derived names ─────────────────────────────────────────────────────────
  const activeVenue = venues.find((v) => v.id === resolvedVenueId) ?? null;

  // For arena routes, the active arena is in the arenas list
  const activeArenaId: string | null =
    depth === 'arena'
      ? (paramArenaId ?? null)
      : null;
  const activeArena = arenas.find((a) => a.id === activeArenaId) ?? null;

  // ── Org segment ───────────────────────────────────────────────────────────
  function handleOrgSelect(id: string) {
    setActiveTenantId(id);
    router.push('/dashboard');
  }

  // ── Venue segment ─────────────────────────────────────────────────────────
  function handleVenueSelect(id: string) {
    router.push(`/venues/${id}?tenantId=${activeTenantId}`);
  }

  // ── Arena segment ─────────────────────────────────────────────────────────
  function handleArenaSelect(id: string) {
    router.push(`/arenas/${id}?tenantId=${activeTenantId}`);
  }

  // ── Render ────────────────────────────────────────────────────────────────
  if (tenants.length === 0) {
    return <span className="text-sm text-slate-400">No organization</span>;
  }

  return (
    <div className="flex items-center gap-0.5">
      {/* Org */}
      <OrgSwitcher
        tenants={tenants.map((t) => ({ id: t.id, name: t.name }))}
        currentId={activeTenantId}
        subtitle={venuesLoading ? null : `${venues.length} venue${venues.length === 1 ? '' : 's'}`}
        onSelect={handleOrgSelect}
      />

      {/* Venue segment (shown on venue + arena routes) */}
      {(depth === 'venue' || depth === 'arena') && (
        <>
          <Separator />
          <Segment
            label={
              venuesLoading && !activeVenue ? '…' :
              activeVenue?.name ?? (resolvedVenueId ? '…' : '…')
            }
            loading={venuesLoading || (depth === 'arena' && arenaLoading && !arena)}
            items={venues.map((v) => ({ id: v.id, name: v.name }))}
            currentId={resolvedVenueId}
            onSelect={handleVenueSelect}
          />
        </>
      )}

      {/* Arena segment (shown on arena routes only) */}
      {depth === 'arena' && (
        <>
          <Separator />
          <Segment
            label={
              arenasLoading && !activeArena ? '…' :
              activeArena?.name ?? (activeArenaId ? '…' : '…')
            }
            loading={arenasLoading || arenaLoading}
            items={arenas.map((a) => ({ id: a.id, name: a.name }))}
            currentId={activeArenaId}
            onSelect={handleArenaSelect}
          />
        </>
      )}
    </div>
  );
}

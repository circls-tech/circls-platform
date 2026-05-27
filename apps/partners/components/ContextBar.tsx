'use client';
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
      className="text-brand-600 shrink-0"
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
}

function Segment({ label, loading, items, currentId, onSelect }: SegmentProps) {
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
  const activeTenant = tenants.find((t) => t.id === activeTenantId) ?? tenants[0] ?? null;
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
  // Org segment is always shown
  const orgLabel = activeTenant?.name ?? (tenants.length === 0 ? 'No organization' : '…');

  if (tenants.length === 0) {
    return <span className="text-sm text-slate-400">No organization</span>;
  }

  return (
    <div className="flex items-center gap-0.5">
      {/* Org */}
      <Segment
        label={orgLabel}
        items={tenants.map((t) => ({ id: t.id, name: t.name }))}
        currentId={activeTenantId}
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

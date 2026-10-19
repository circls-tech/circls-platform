'use client';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { QrTicketConfigEditor } from '@/components/QrTicketConfigEditor';
import { ReceptionButton } from '@/components/ReceptionButton';
import { CloseReopenControl } from '@/components/CloseReopenControl';
import { ListingPreviewModal } from '@/components/ListingPreviewModal';
import { useArenas, useCreateArena, useSetVenueOpen, useVenue } from '@/lib/api/queries';
import { inferSport } from '@/lib/api/sport_inference';
import type { QrTicketConfig } from '@/lib/api/types';
import { isArenaOnShelf } from '@/lib/shelf';
import { useCan } from '@/lib/use_can';
import { Badge, Button, StatusPill, TagsInput } from '@/lib/ui';

type ArenaShelf = 'open' | 'closed';

/** Same split as the Venues page: what is taking bookings (or about to) on
 *  one tab, what a partner closed or circls rejected on the other. */
const SHELF_TABS: { key: ArenaShelf; label: string }[] = [
  { key: 'open', label: 'Active' },
  { key: 'closed', label: 'Closed & rejected' },
];

export default function VenuePage() {
  const { venueId } = useParams<{ venueId: string }>();
  const tenantId = useSearchParams().get('tenantId') ?? '';
  const { data: venue } = useVenue(venueId);
  const { data: arenas, isLoading } = useArenas(venueId);
  const createArena = useCreateArena(venueId);
  const setVenueOpen = useSetVenueOpen(venueId);
  // The venue's own organisation decides, once it has loaded.
  const venueTenantId = venue?.tenantId ?? tenantId;
  const canEditVenue = useCan('venues.write', venueTenantId);
  const canAddArena = useCan('arenas.write', venueTenantId);
  const [name, setName] = useState('');
  const [sport, setSport] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [qrConfig, setQrConfig] = useState<QrTicketConfig | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [created, setCreated] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [shelf, setShelf] = useState<ArenaShelf>('open');

  const inferredSport = !sport ? inferSport(tags) : null;

  const offShelf = (arenas ?? []).filter((a) => !isArenaOnShelf(a));
  const shown = shelf === 'closed' ? offShelf : (arenas ?? []).filter(isArenaOnShelf);
  const counts: Record<ArenaShelf, number> = {
    open: (arenas?.length ?? 0) - offShelf.length,
    closed: offShelf.length,
  };

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    setCreated(false);
    try {
      await createArena.mutateAsync({
        name,
        ...(sport ? { sport } : {}),
        tags,
        ...(qrConfig ? { qrTicketConfig: qrConfig } : {}),
      });
      setName('');
      setSport('');
      setTags([]);
      setQrConfig(null);
      setCreated(true);
      // A new arena is pending review, so it lands on the Active tab; show it
      // rather than leave the partner on the other tab wondering where it went.
      setShelf('open');
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Link href="/venues" className="text-sm text-gray-500">
        ← Venues
      </Link>
      {venue && (
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-[family-name:var(--font-display)] text-2xl font-extrabold tracking-tight text-[#17151D]">
            {venue.name}
          </h1>
          <StatusPill
            status={venue.status}
            {...(venue.status === 'suspended' ? { label: 'Closed' } : {})}
          />
          {/* The venue's page on the customer site, whatever its status — the
              only way to see a pending venue (and its pending arenas) as
              customers will. */}
          <Button variant="secondary" size="sm" onClick={() => setPreviewOpen(true)}>
            Preview
          </Button>
          {/* Details and photos live on their own page, so this one can lead
              with the arenas. Read-only members can still read them. */}
          <Link href={`/venues/${venue.id}/details${tenantId ? `?tenantId=${tenantId}` : ''}`}>
            <Button variant="secondary" size="sm">
              {canEditVenue ? 'Edit details' : 'Details'}
            </Button>
          </Link>
          <ListingPreviewModal
            open={previewOpen}
            onClose={() => setPreviewOpen(false)}
            tenantId={venueTenantId}
            type="venue"
            id={venue.id}
          />
          {canEditVenue && (
            <span className="ml-auto">
              <CloseReopenControl
                noun="venue"
                target={venue}
                venueId={venue.id}
                tenantId={tenantId}
                setOpen={setVenueOpen}
              />
            </span>
          )}
        </div>
      )}
      <div className="flex items-center justify-between gap-3">
        <h1 className="font-[family-name:var(--font-display)] text-2xl font-extrabold tracking-tight text-[#17151D]">Arenas</h1>
        <div className="flex gap-2">
          <Link
            href={`/venues/${venueId}/events${tenantId ? `?tenantId=${tenantId}` : ''}`}
            className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-50"
          >
            Events →
          </Link>
          <Link
            href={`/venues/${venueId}/bookings${tenantId ? `?tenantId=${tenantId}` : ''}`}
            className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-50"
          >
            View bookings →
          </Link>
        </div>
      </div>
      {isLoading && <p className="text-gray-500">Loading…</p>}
      {arenas && (
        <div className="flex gap-1" role="tablist" aria-label="Arena shelf">
          {SHELF_TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={shelf === t.key}
              onClick={() => setShelf(t.key)}
              className={[
                'rounded-[var(--radius)] border-2 px-3 py-1 text-sm font-bold transition-colors',
                shelf === t.key
                  ? 'border-[#17151D] bg-[#BCE3A0] text-[#17151D] shadow-[2px_2px_0_#17151D]'
                  : 'border-transparent text-slate-500 hover:bg-white hover:text-[#17151D]',
              ].join(' ')}
            >
              {t.label} <span className="font-normal text-slate-500">({counts[t.key]})</span>
            </button>
          ))}
        </div>
      )}
      {arenas && shown.length === 0 && (
        <p className="text-sm text-gray-500">
          {arenas.length === 0
            ? 'No arenas yet.'
            : shelf === 'closed'
              ? 'No closed or rejected arenas.'
              : 'No active arenas. Closed and rejected ones are on the other tab.'}
        </p>
      )}
      <ul className="flex flex-col gap-2">
        {shown.map((a) => (
          <li
            key={a.id}
            className="rounded border border-gray-200 bg-white p-3 hover:border-brand-400"
          >
            <div className="flex items-center gap-2">
              {/* The row has always opened reception; it just never said so.
                  The name still goes there, and the button now names it —
                  which is why these are siblings rather than nested links. */}
              <Link
                href={`/arenas/${a.id}?tenantId=${tenantId}`}
                className="font-medium hover:underline"
              >
                {a.name}
              </Link>
              <span className="text-xs text-gray-400">{a.sport ?? 'sport n/a'}</span>
              <span className="ml-auto flex items-center gap-2">
                <StatusPill
                  status={a.status}
                  {...(a.status === 'suspended' ? { label: 'Closed' } : {})}
                />
                <ReceptionButton href={`/arenas/${a.id}?tenantId=${tenantId}`} />
              </span>
            </div>
            {a.tags && a.tags.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {a.tags.map((tag) => (
                  <Badge key={tag} tone="neutral" label={tag} />
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
      {canAddArena && (
        <form
          onSubmit={onCreate}
          className="flex max-w-md flex-col gap-3 rounded border border-gray-200 bg-white p-4"
        >
          <h2 className="font-medium">Add an arena</h2>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Court 1"
            className="rounded border border-gray-300 px-3 py-2 text-sm"
          />
          <input
            value={sport}
            onChange={(e) => setSport(e.target.value)}
            placeholder="sport (optional)"
            className="rounded border border-gray-300 px-3 py-2 text-sm"
          />
          <TagsInput
            value={tags}
            onChange={setTags}
            placeholder="e.g. indoor, nets…"
          />
          {inferredSport && (
            <p className="text-xs text-slate-500">
              Will be classified as: <span className="font-semibold text-slate-700">{inferredSport}</span>
            </p>
          )}
          <QrTicketConfigEditor value={qrConfig} onChange={setQrConfig} itemNoun="booking" />
          <button
            type="submit"
            disabled={createArena.isPending}
            className="rounded bg-brand-600 px-4 py-2 text-sm text-slate-900 disabled:opacity-50"
          >
            {createArena.isPending ? 'Adding…' : 'Add arena'}
          </button>
          {created && (
            <p className="text-sm text-amber-700">
              Arena created. It’s now pending review by Circls before it goes live.
            </p>
          )}
          {err && <p className="text-sm text-red-600">{err}</p>}
        </form>
      )}
    </div>
  );
}

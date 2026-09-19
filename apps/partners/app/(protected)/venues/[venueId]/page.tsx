'use client';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { VenueImages } from '@/components/VenueImages';
import { VenueDetailsForm } from '@/components/VenueDetailsForm';
import { QrTicketConfigEditor } from '@/components/QrTicketConfigEditor';
import { ReceptionButton } from '@/components/ReceptionButton';
import { CloseReopenControl } from '@/components/CloseReopenControl';
import { useArenas, useCreateArena, useSetVenueOpen, useVenue } from '@/lib/api/queries';
import { inferSport } from '@/lib/api/sport_inference';
import type { QrTicketConfig } from '@/lib/api/types';
import { Badge, StatusPill, TagsInput } from '@/lib/ui';

export default function VenuePage() {
  const { venueId } = useParams<{ venueId: string }>();
  const tenantId = useSearchParams().get('tenantId') ?? '';
  const { data: venue } = useVenue(venueId);
  const { data: arenas, isLoading } = useArenas(venueId);
  const createArena = useCreateArena(venueId);
  const setVenueOpen = useSetVenueOpen(venueId);
  const [name, setName] = useState('');
  const [sport, setSport] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [qrConfig, setQrConfig] = useState<QrTicketConfig | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [created, setCreated] = useState(false);

  const inferredSport = !sport ? inferSport(tags) : null;

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
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Link href={`/tenants/${tenantId}`} className="text-sm text-gray-500">
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
          <span className="ml-auto">
            <CloseReopenControl
              noun="venue"
              target={venue}
              venueId={venue.id}
              tenantId={tenantId}
              setOpen={setVenueOpen}
            />
          </span>
        </div>
      )}
      {venue && <VenueDetailsForm venue={venue} />}
      <VenueImages venueId={venueId} />
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
      <ul className="flex flex-col gap-2">
        {arenas?.map((a) => (
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
        {arenas?.length === 0 && <p className="text-sm text-gray-500">No arenas yet.</p>}
      </ul>
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
    </div>
  );
}

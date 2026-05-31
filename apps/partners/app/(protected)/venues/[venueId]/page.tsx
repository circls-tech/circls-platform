'use client';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { VenueImages } from '@/components/VenueImages';
import { useArenas, useCreateArena } from '@/lib/api/queries';
import { inferSport } from '@/lib/api/sport_inference';
import { Badge, StatusPill, TagsInput } from '@/lib/ui';

export default function VenuePage() {
  const { venueId } = useParams<{ venueId: string }>();
  const tenantId = useSearchParams().get('tenantId') ?? '';
  const { data: arenas, isLoading } = useArenas(venueId);
  const createArena = useCreateArena(venueId);
  const [name, setName] = useState('');
  const [sport, setSport] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [created, setCreated] = useState(false);

  const inferredSport = !sport ? inferSport(tags) : null;

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    setCreated(false);
    try {
      await createArena.mutateAsync({ name, ...(sport ? { sport } : {}), tags });
      setName('');
      setSport('');
      setTags([]);
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
      <VenueImages venueId={venueId} />
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Arenas</h1>
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
          <li key={a.id}>
            <Link
              href={`/arenas/${a.id}?tenantId=${tenantId}`}
              className="block rounded border border-gray-200 bg-white p-3 hover:border-blue-400"
            >
              <div className="flex items-center gap-2">
                <span className="font-medium">{a.name}</span>
                <span className="text-xs text-gray-400">
                  {a.sport ?? 'sport n/a'} · {a.slotDurationMin}min slots
                </span>
                <span className="ml-auto">
                  <StatusPill status={a.status} />
                </span>
              </div>
              {a.tags && a.tags.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {a.tags.map((tag) => (
                    <Badge key={tag} tone="neutral" label={tag} />
                  ))}
                </div>
              )}
            </Link>
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
        <button
          type="submit"
          disabled={createArena.isPending}
          className="rounded bg-blue-600 px-4 py-2 text-sm text-white disabled:opacity-50"
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

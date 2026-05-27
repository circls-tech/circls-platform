'use client';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { useArenas, useCreateArena } from '@/lib/api/queries';

export default function VenuePage() {
  const { venueId } = useParams<{ venueId: string }>();
  const tenantId = useSearchParams().get('tenantId') ?? '';
  const { data: arenas, isLoading } = useArenas(venueId);
  const createArena = useCreateArena(venueId);
  const [name, setName] = useState('');
  const [sport, setSport] = useState('');
  const [err, setErr] = useState<string | null>(null);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    try {
      await createArena.mutateAsync({ name, ...(sport ? { sport } : {}) });
      setName('');
      setSport('');
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Link href={`/tenants/${tenantId}`} className="text-sm text-gray-500">
        ← Venues
      </Link>
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Arenas</h1>
        <Link
          href={`/venues/${venueId}/bookings${tenantId ? `?tenantId=${tenantId}` : ''}`}
          className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-50"
        >
          View bookings →
        </Link>
      </div>
      {isLoading && <p className="text-gray-500">Loading…</p>}
      <ul className="flex flex-col gap-2">
        {arenas?.map((a) => (
          <li key={a.id}>
            <Link
              href={`/arenas/${a.id}?tenantId=${tenantId}`}
              className="block rounded border border-gray-200 bg-white p-3 hover:border-blue-400"
            >
              <span className="font-medium">{a.name}</span>
              <span className="ml-2 text-xs text-gray-400">
                {a.sport ?? 'sport n/a'} · {a.slotDurationMin}min slots
              </span>
            </Link>
          </li>
        ))}
        {arenas?.length === 0 && <p className="text-sm text-gray-500">No arenas yet.</p>}
      </ul>
      <form
        onSubmit={onCreate}
        className="flex max-w-md flex-col gap-2 rounded border border-gray-200 bg-white p-4"
      >
        <h2 className="font-medium">Add an arena</h2>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Court 1"
          className="rounded border border-gray-300 px-3 py-2"
        />
        <input
          value={sport}
          onChange={(e) => setSport(e.target.value)}
          placeholder="sport (optional)"
          className="rounded border border-gray-300 px-3 py-2"
        />
        <button
          type="submit"
          disabled={createArena.isPending}
          className="rounded bg-blue-600 px-4 py-2 text-white disabled:opacity-50"
        >
          {createArena.isPending ? 'Adding…' : 'Add arena'}
        </button>
        {err && <p className="text-sm text-red-600">{err}</p>}
      </form>
    </div>
  );
}

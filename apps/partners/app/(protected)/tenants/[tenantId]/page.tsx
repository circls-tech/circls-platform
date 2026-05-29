'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { useCreateVenue, useVenues } from '@/lib/api/queries';
import { StatusPill } from '@/lib/ui';

export default function TenantPage() {
  const { tenantId } = useParams<{ tenantId: string }>();
  const { data: venues, isLoading } = useVenues(tenantId);
  const createVenue = useCreateVenue(tenantId);
  const [name, setName] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [created, setCreated] = useState(false);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    setCreated(false);
    try {
      await createVenue.mutateAsync({ name });
      setName('');
      setCreated(true);
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Link href="/dashboard" className="text-sm text-gray-500">
        ← Dashboard
      </Link>
      <h1 className="text-xl font-semibold">Venues</h1>
      {isLoading && <p className="text-gray-500">Loading…</p>}
      <ul className="flex flex-col gap-2">
        {venues?.map((v) => (
          <li key={v.id}>
            <Link
              href={`/venues/${v.id}?tenantId=${tenantId}`}
              className="flex items-center justify-between gap-2 rounded border border-gray-200 bg-white p-3 hover:border-blue-400"
            >
              <span>
                <span className="font-medium">{v.name}</span>
                <span className="ml-2 text-xs text-gray-400">{v.tzName}</span>
              </span>
              <StatusPill status={v.status} />
            </Link>
          </li>
        ))}
        {venues?.length === 0 && <p className="text-sm text-gray-500">No venues yet.</p>}
      </ul>
      <form
        onSubmit={onCreate}
        className="flex max-w-md flex-col gap-2 rounded border border-gray-200 bg-white p-4"
      >
        <h2 className="font-medium">Add a venue</h2>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Venue name"
          className="rounded border border-gray-300 px-3 py-2"
        />
        <button
          type="submit"
          disabled={createVenue.isPending}
          className="rounded bg-blue-600 px-4 py-2 text-white disabled:opacity-50"
        >
          {createVenue.isPending ? 'Adding…' : 'Add venue'}
        </button>
        {created && (
          <p className="text-sm text-amber-700">
            Venue created. It’s now pending review by Circls before it goes live.
          </p>
        )}
        {err && <p className="text-sm text-red-600">{err}</p>}
      </form>
    </div>
  );
}

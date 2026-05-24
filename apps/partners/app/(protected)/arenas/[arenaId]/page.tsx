'use client';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { type FormEvent, useMemo, useState } from 'react';
import { useArenaBookings, useCancelBooking, useCreateBooking } from '@/lib/api/queries';

function dayRange(dateStr: string) {
  const start = new Date(`${dateStr}T00:00:00`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { fromISO: start.toISOString(), toISO: end.toISOString() };
}
function rupees(paise: number | null) {
  return paise == null ? '—' : `₹${(paise / 100).toFixed(0)}`;
}

export default function ArenaPage() {
  const { arenaId } = useParams<{ arenaId: string }>();
  const tenantId = useSearchParams().get('tenantId') ?? '';
  const today = new Date().toISOString().slice(0, 10);

  const [date, setDate] = useState(today);
  const { fromISO, toISO } = useMemo(() => dayRange(date), [date]);
  const { data: bookings, isLoading } = useArenaBookings(arenaId, fromISO, toISO);
  const createBooking = useCreateBooking(arenaId);
  const cancelBooking = useCancelBooking(arenaId);

  const [startLocal, setStartLocal] = useState(`${today}T10:00`);
  const [durationMin, setDurationMin] = useState(60);
  const [price, setPrice] = useState('');
  const [err, setErr] = useState<string | null>(null);

  async function onBook(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    try {
      const startMs = new Date(startLocal).getTime();
      await createBooking.mutateAsync({
        tenantId,
        arenaId,
        startAt: new Date(startMs).toISOString(),
        endAt: new Date(startMs + durationMin * 60 * 1000).toISOString(),
        ...(price ? { pricePaise: Math.round(Number(price) * 100) } : {}),
      });
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Link href="/dashboard" className="text-sm text-gray-500">
        ← Dashboard
      </Link>
      <h1 className="text-xl font-semibold">Reception — walk-in bookings</h1>

      <div className="flex items-center gap-2">
        <label className="text-sm" htmlFor="day">
          Day
        </label>
        <input
          id="day"
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="rounded border border-gray-300 px-2 py-1"
        />
      </div>

      <section className="flex flex-col gap-2">
        {isLoading && <p className="text-gray-500">Loading bookings…</p>}
        {bookings?.length === 0 && <p className="text-sm text-gray-500">No bookings this day.</p>}
        {bookings?.map((b) => (
          <div
            key={b.id}
            className="flex items-center justify-between rounded border border-gray-200 bg-white p-3"
          >
            <div>
              <span className="font-mono text-xs">{b.timeRange}</span>
              <span className="ml-2 text-xs text-gray-400">
                {b.status} · {b.channel} · {rupees(b.pricePaise)}
              </span>
            </div>
            {b.status !== 'cancelled' && (
              <button
                type="button"
                onClick={() => cancelBooking.mutate(b.id)}
                className="text-sm text-red-600 hover:underline"
              >
                Cancel
              </button>
            )}
          </div>
        ))}
      </section>

      <form
        onSubmit={onBook}
        className="flex max-w-md flex-col gap-2 rounded border border-gray-200 bg-white p-4"
      >
        <h2 className="font-medium">New walk-in booking</h2>
        <label className="text-sm" htmlFor="start">
          Start
        </label>
        <input
          id="start"
          type="datetime-local"
          value={startLocal}
          onChange={(e) => setStartLocal(e.target.value)}
          className="rounded border border-gray-300 px-3 py-2"
        />
        <label className="text-sm" htmlFor="dur">
          Duration (min)
        </label>
        <input
          id="dur"
          type="number"
          value={durationMin}
          onChange={(e) => setDurationMin(Number(e.target.value))}
          className="rounded border border-gray-300 px-3 py-2"
        />
        <label className="text-sm" htmlFor="price">
          Price (₹, optional — else resolved from pricing rules)
        </label>
        <input
          id="price"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          placeholder="500"
          className="rounded border border-gray-300 px-3 py-2"
        />
        <button
          type="submit"
          disabled={createBooking.isPending || !tenantId}
          className="rounded bg-blue-600 px-4 py-2 text-white disabled:opacity-50"
        >
          {createBooking.isPending ? 'Booking…' : 'Create booking'}
        </button>
        {!tenantId && (
          <p className="text-xs text-amber-600">
            Open this arena via a venue so the tenant context is set.
          </p>
        )}
        {err && <p className="text-sm text-red-600">{err}</p>}
      </form>
    </div>
  );
}

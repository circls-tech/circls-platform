'use client';

import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { useArenas } from '@/lib/api/queries';
import { useCreateEvent } from '@/lib/api/events';
import { Button, Card, Input } from '@/lib/ui';

/**
 * Convert a `<input type="datetime-local">` value (interpreted as Asia/Kolkata
 * by venue convention) into a UTC ISO string. Browsers treat the value as
 * local-time; we re-interpret it in the venue's tz so the API receives the
 * correct absolute instant regardless of where the partner happens to be.
 */
function localToVenueTzIso(local: string, tz: string): string {
  if (!local) return '';
  // Build a probe Date that represents the local-time string as if it were UTC,
  // then back out the tz offset by formatting in `tz` and computing the diff.
  const asIfUtc = new Date(`${local}:00Z`);
  // The tz "wall clock" string of the asIfUtc instant:
  const wall = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(asIfUtc);
  // wall: "YYYY-MM-DD, HH:MM:SS"
  const [datePart, timePart] = wall.split(', ');
  const wallIso = `${datePart}T${timePart}Z`;
  const offsetMs = new Date(wallIso).getTime() - asIfUtc.getTime();
  return new Date(asIfUtc.getTime() - offsetMs).toISOString();
}

export default function NewEventPage() {
  const router = useRouter();
  const { venueId } = useParams<{ venueId: string }>();
  const tenantId = useSearchParams().get('tenantId') ?? '';
  const { data: arenas } = useArenas(venueId);
  const createEvent = useCreateEvent(venueId);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [startsAtLocal, setStartsAtLocal] = useState('');
  const [endsAtLocal, setEndsAtLocal] = useState('');
  const [priceRupees, setPriceRupees] = useState('0');
  const [capacityRaw, setCapacityRaw] = useState('');
  const [selectedArenaIds, setSelectedArenaIds] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);

  function toggleArena(id: string) {
    setSelectedArenaIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  // Best-effort tz; the venue row owns the source of truth but we keep this
  // page tz-pinned to IST for now (matches the rest of the app's IST UI).
  const tz = 'Asia/Kolkata';

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    if (selectedArenaIds.length === 0) {
      setErr('Pick at least one arena.');
      return;
    }
    if (!startsAtLocal || !endsAtLocal) {
      setErr('Set a start and end time.');
      return;
    }
    const pricePaise = Math.round(parseFloat(priceRupees || '0') * 100);
    const capacityNum = capacityRaw ? parseInt(capacityRaw, 10) : undefined;
    try {
      await createEvent.mutateAsync({
        name,
        ...(description ? { description } : {}),
        startsAt: localToVenueTzIso(startsAtLocal, tz),
        endsAt: localToVenueTzIso(endsAtLocal, tz),
        pricePaise,
        ...(capacityNum !== undefined ? { capacity: capacityNum } : {}),
        arenaIds: selectedArenaIds,
      });
      router.push(`/venues/${venueId}/events${tenantId ? `?tenantId=${tenantId}` : ''}`);
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Link
        href={`/venues/${venueId}/events${tenantId ? `?tenantId=${tenantId}` : ''}`}
        className="text-sm text-slate-500 hover:text-slate-800 transition-colors"
      >
        &larr; Events
      </Link>
      <h1 className="text-xl font-semibold text-[#0f172a]">New event</h1>

      <Card title="Details" subtitle="Events are created as drafts. Publish when you're ready to accept bookings.">
        <form onSubmit={onSubmit} className="flex max-w-2xl flex-col gap-4">
          <Input
            label="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            placeholder="Sunday Tournament"
          />
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium uppercase tracking-wide text-[#475569]">
              Description
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              className="w-full rounded-[var(--radius)] border border-[#e5e7eb] bg-white px-3 py-2 text-sm text-[#0f172a] placeholder:text-[#94a3b8] hover:border-slate-300"
              placeholder="Optional"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Input
              label={`Starts (${tz})`}
              type="datetime-local"
              value={startsAtLocal}
              onChange={(e) => setStartsAtLocal(e.target.value)}
              required
            />
            <Input
              label={`Ends (${tz})`}
              type="datetime-local"
              value={endsAtLocal}
              onChange={(e) => setEndsAtLocal(e.target.value)}
              required
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Input
              label="Price (₹)"
              type="number"
              min={0}
              step="0.01"
              value={priceRupees}
              onChange={(e) => setPriceRupees(e.target.value)}
              hint="Leave 0 for a free event."
            />
            <Input
              label="Capacity"
              type="number"
              min={1}
              value={capacityRaw}
              onChange={(e) => setCapacityRaw(e.target.value)}
              hint="Maximum seats. Leave blank for unlimited."
            />
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium uppercase tracking-wide text-[#475569]">
              Arenas (select one or more)
            </label>
            <div className="flex flex-wrap gap-2">
              {arenas?.map((a) => {
                const on = selectedArenaIds.includes(a.id);
                return (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => toggleArena(a.id)}
                    className={[
                      'rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
                      on
                        ? 'border-blue-600 bg-blue-50 text-blue-700'
                        : 'border-[#e5e7eb] bg-white text-slate-600 hover:bg-slate-50',
                    ].join(' ')}
                  >
                    {a.name}
                  </button>
                );
              })}
              {arenas?.length === 0 && (
                <p className="text-xs text-slate-400">
                  No arenas yet — create one on the venue page first.
                </p>
              )}
            </div>
          </div>

          {err && <p className="text-sm text-red-600">{err}</p>}

          <div className="flex justify-end gap-2 pt-2">
            <Link
              href={`/venues/${venueId}/events${tenantId ? `?tenantId=${tenantId}` : ''}`}
              className="rounded-[var(--radius)] border border-[#e5e7eb] bg-white px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
            >
              Cancel
            </Link>
            <Button type="submit" loading={createEvent.isPending}>
              Create event
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}

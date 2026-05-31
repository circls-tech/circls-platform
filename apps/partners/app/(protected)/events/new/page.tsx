'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { useOrg } from '@/lib/org_context';
import { useVenues } from '@/lib/api/queries';
import { useCreateTenantEvent, type CreateTenantEventInput } from '@/lib/api/events';
import { Button, Card, Input } from '@/lib/ui';

/** Re-interpret a datetime-local value in the given tz as a UTC ISO string. */
function localToTzIso(local: string, tz: string): string {
  if (!local) return '';
  const asIfUtc = new Date(`${local}:00Z`);
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
  const [datePart, timePart] = wall.split(', ');
  const wallIso = `${datePart}T${timePart}Z`;
  const offsetMs = new Date(wallIso).getTime() - asIfUtc.getTime();
  return new Date(asIfUtc.getTime() - offsetMs).toISOString();
}

type Scope = 'venue' | 'standalone';

export default function NewTenantEventPage() {
  const router = useRouter();
  const { activeTenantId } = useOrg();
  const tenantId = activeTenantId ?? '';
  const { data: venues } = useVenues(tenantId);
  const createEvent = useCreateTenantEvent(tenantId);

  const [scope, setScope] = useState<Scope>('venue');
  const [venueId, setVenueId] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [startsAtLocal, setStartsAtLocal] = useState('');
  const [endsAtLocal, setEndsAtLocal] = useState('');
  const [priceRupees, setPriceRupees] = useState('0');
  const [capacityRaw, setCapacityRaw] = useState('');
  const [line1, setLine1] = useState('');
  const [line2, setLine2] = useState('');
  const [city, setCity] = useState('');
  const [stateRegion, setStateRegion] = useState('');
  const [pincode, setPincode] = useState('');
  const [latRaw, setLatRaw] = useState('');
  const [lngRaw, setLngRaw] = useState('');
  const [tz, setTz] = useState('Asia/Kolkata');
  const [err, setErr] = useState<string | null>(null);

  const selectedVenue = venues?.find((v) => v.id === venueId);
  const effectiveTz = scope === 'venue' ? selectedVenue?.tzName ?? 'Asia/Kolkata' : tz;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!startsAtLocal || !endsAtLocal) {
      setErr('Set a start and end time.');
      return;
    }
    if (scope === 'venue' && !venueId) {
      setErr('Pick a venue, or switch to a standalone address.');
      return;
    }
    if (scope === 'standalone' && !line1.trim() && !city.trim()) {
      setErr('Enter at least an address line or city.');
      return;
    }
    const pricePaise = Math.round(parseFloat(priceRupees || '0') * 100);
    const capacityNum = capacityRaw ? parseInt(capacityRaw, 10) : undefined;

    const base = {
      name,
      ...(description ? { description } : {}),
      startsAt: localToTzIso(startsAtLocal, effectiveTz),
      endsAt: localToTzIso(endsAtLocal, effectiveTz),
      pricePaise,
      ...(capacityNum !== undefined ? { capacity: capacityNum } : {}),
    };

    let input: CreateTenantEventInput;
    if (scope === 'venue') {
      input = { ...base, venueId };
    } else {
      const addressJson: Record<string, unknown> = {};
      if (line1.trim()) addressJson.line1 = line1.trim();
      if (line2.trim()) addressJson.line2 = line2.trim();
      if (city.trim()) addressJson.city = city.trim();
      if (stateRegion.trim()) addressJson.state = stateRegion.trim();
      if (pincode.trim()) addressJson.pincode = pincode.trim();
      input = {
        ...base,
        addressJson,
        tzName: tz,
        ...(latRaw ? { lat: parseFloat(latRaw) } : {}),
        ...(lngRaw ? { lng: parseFloat(lngRaw) } : {}),
      };
    }

    try {
      await createEvent.mutateAsync(input);
      router.push('/events');
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  if (!activeTenantId) {
    return <p className="text-sm text-slate-500">Select an organization first.</p>;
  }

  return (
    <div className="flex flex-col gap-6">
      <Link href="/events" className="text-sm text-slate-500 hover:text-slate-800 transition-colors">
        &larr; Events
      </Link>
      <h1 className="text-xl font-semibold text-[#0f172a]">New event</h1>

      <Card title="Details" subtitle="Events are created as drafts. Submit for review when you're ready — Circls approves it before it goes live for consumers.">
        <form onSubmit={onSubmit} className="flex max-w-2xl flex-col gap-4">
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium uppercase tracking-wide text-[#475569]">Where</label>
            <div className="inline-flex w-fit rounded-md border border-slate-200 bg-white p-0.5">
              {(['venue', 'standalone'] as Scope[]).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setScope(s)}
                  className={[
                    'rounded px-3 py-1.5 text-sm font-medium transition-colors',
                    scope === s ? 'bg-slate-900 text-white' : 'text-slate-600 hover:text-slate-900',
                  ].join(' ')}
                >
                  {s === 'venue' ? 'At a venue' : 'No venue — enter address'}
                </button>
              ))}
            </div>
          </div>

          {scope === 'venue' ? (
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium uppercase tracking-wide text-[#475569]">Venue</label>
              <select
                value={venueId}
                onChange={(e) => setVenueId(e.target.value)}
                className="w-full rounded-[var(--radius)] border border-[#e5e7eb] bg-white px-3 py-2 text-sm text-[#0f172a]"
              >
                <option value="">Select a venue…</option>
                {venues?.map((v) => (
                  <option key={v.id} value={v.id}>{v.name}</option>
                ))}
              </select>
            </div>
          ) : (
            <div className="flex flex-col gap-3 rounded-[var(--radius)] border border-[#e5e7eb] bg-slate-50 p-3">
              <Input label="Address line 1" value={line1} onChange={(e) => setLine1(e.target.value)} placeholder="Street / building" />
              <Input label="Address line 2" value={line2} onChange={(e) => setLine2(e.target.value)} placeholder="Optional" />
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <Input label="City" value={city} onChange={(e) => setCity(e.target.value)} />
                <Input label="State" value={stateRegion} onChange={(e) => setStateRegion(e.target.value)} />
                <Input label="PIN" value={pincode} onChange={(e) => setPincode(e.target.value)} />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <Input label="Latitude" type="number" step="0.000001" value={latRaw} onChange={(e) => setLatRaw(e.target.value)} hint="Optional — for the map pin." />
                <Input label="Longitude" type="number" step="0.000001" value={lngRaw} onChange={(e) => setLngRaw(e.target.value)} />
                <Input label="Timezone" value={tz} onChange={(e) => setTz(e.target.value)} hint="IANA tz, e.g. Asia/Kolkata" />
              </div>
            </div>
          )}

          <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} required placeholder="Sunday Tournament" />
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium uppercase tracking-wide text-[#475569]">Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              className="w-full rounded-[var(--radius)] border border-[#e5e7eb] bg-white px-3 py-2 text-sm text-[#0f172a] placeholder:text-[#94a3b8] hover:border-slate-300"
              placeholder="Optional"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Input label={`Starts (${effectiveTz})`} type="datetime-local" value={startsAtLocal} onChange={(e) => setStartsAtLocal(e.target.value)} required />
            <Input label={`Ends (${effectiveTz})`} type="datetime-local" value={endsAtLocal} onChange={(e) => setEndsAtLocal(e.target.value)} required />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Input label="Price (₹)" type="number" min={0} step="0.01" value={priceRupees} onChange={(e) => setPriceRupees(e.target.value)} hint="Leave 0 for a free event." />
            <Input label="Capacity" type="number" min={1} value={capacityRaw} onChange={(e) => setCapacityRaw(e.target.value)} hint="Maximum seats. Leave blank for unlimited." />
          </div>

          {err && <p className="text-sm text-red-600">{err}</p>}

          <div className="flex justify-end gap-2 pt-2">
            <Link href="/events" className="rounded-[var(--radius)] border border-[#e5e7eb] bg-white px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50">
              Cancel
            </Link>
            <Button type="submit" loading={createEvent.isPending}>Create event</Button>
          </div>
        </form>
      </Card>
    </div>
  );
}

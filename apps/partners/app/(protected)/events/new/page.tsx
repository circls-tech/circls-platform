'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { useOrg } from '@/lib/org_context';
import { useVenues, uploadEventImageFile } from '@/lib/api/queries';
import {
  isSeriesResult,
  useCreateTenantEvent,
  type CreateTenantEventInput,
} from '@/lib/api/events';
import { useVenueCurrencies } from '@/lib/currency';
import { TiersEditor, emptyTier, tiersToPayload, type TierDraft } from '@/components/TiersEditor';
import { PendingPhotosPicker, type PendingPhoto } from '@/components/PendingPhotos';
import {
  RecurrenceEditor,
  emptyRecurrence,
  occurrencePayloads,
  type RecurrenceValue,
} from '@/components/RecurrenceEditor';
import { QrTicketConfigEditor } from '@/components/QrTicketConfigEditor';
import type { QrTicketConfig } from '@/lib/api/types';
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
  const [tiers, setTiers] = useState<TierDraft[]>([emptyTier()]);
  const [qrConfig, setQrConfig] = useState<QrTicketConfig | null>(null);
  const [photos, setPhotos] = useState<PendingPhoto[]>([]);
  const [recurrence, setRecurrence] = useState<RecurrenceValue>(emptyRecurrence());
  const [uploadProgress, setUploadProgress] = useState<{ done: number; total: number } | null>(
    null,
  );
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
  // Ticket prices follow the selected venue's currency (tenant currency for
  // standalone events, whose address form has no country field).
  const { currencyFor } = useVenueCurrencies();
  const currency = currencyFor(scope === 'venue' ? venueId || null : null);
  const busy = createEvent.isPending || uploadProgress !== null;

  /** Timezone for one series date — its override venue's tz, else the event's. */
  function tzForVenue(overrideVenueId: string | undefined): string {
    if (overrideVenueId) {
      return venues?.find((v) => v.id === overrideVenueId)?.tzName ?? effectiveTz;
    }
    return effectiveTz;
  }

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
    if (tiers.some((t) => !t.name.trim())) {
      setErr('Give every ticket tier a name.');
      return;
    }

    const isWeekly = recurrence.mode === 'weekly';
    const occurrences = isWeekly
      ? occurrencePayloads(recurrence, tzForVenue, localToTzIso)
      : undefined;
    if (isWeekly) {
      if (!recurrence.until) {
        setErr('Pick the last date of the recurring event.');
        return;
      }
      if ((occurrences?.length ?? 0) < 2) {
        setErr(
          'A recurring event needs at least 2 dates — adjust the days or last date, or switch to "One time".',
        );
        return;
      }
      if (occurrences!.some((o) => o.tiers?.some((t) => !t.name.trim()))) {
        setErr('Give every custom ticket tier (Advanced settings) a name.');
        return;
      }
    }

    const base = {
      name,
      ...(description ? { description } : {}),
      ...(occurrences
        ? { occurrences }
        : {
            startsAt: localToTzIso(startsAtLocal, effectiveTz),
            endsAt: localToTzIso(endsAtLocal, effectiveTz),
          }),
      tiers: tiersToPayload(tiers),
      qrTicketConfig: qrConfig,
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
      const result = await createEvent.mutateAsync(input);
      // For a series, photos land on the first date — the other dates (and the
      // consumer pages) borrow that gallery.
      const anchor = isSeriesResult(result) ? result.events[0]! : result;
      if (photos.length > 0) {
        setUploadProgress({ done: 0, total: photos.length });
        try {
          for (let i = 0; i < photos.length; i++) {
            await uploadEventImageFile(anchor.id, photos[i]!.file);
            setUploadProgress({ done: i + 1, total: photos.length });
          }
        } catch (uploadErr) {
          setUploadProgress(null);
          setErr(
            `Your event was created, but a photo failed to upload (${(uploadErr as Error).message}) — you can add the rest from the event page.`,
          );
          router.push(`/events/${anchor.id}`);
          return;
        }
        setUploadProgress(null);
      }
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

          <RecurrenceEditor
            value={recurrence}
            onChange={setRecurrence}
            baseStartLocal={startsAtLocal}
            baseEndLocal={endsAtLocal}
            venues={(venues ?? []).map((v) => ({ id: v.id, name: v.name }))}
            baseLocationLabel={
              scope === 'venue'
                ? `Same as event${selectedVenue ? ` — ${selectedVenue.name}` : ''}`
                : 'Same as event — standalone address'
            }
            baseTiers={tiers}
            currency={currency}
          />

          <TiersEditor value={tiers} onChange={setTiers} currency={currency} />

          <QrTicketConfigEditor value={qrConfig} onChange={setQrConfig} itemNoun="event" />

          <PendingPhotosPicker photos={photos} onChange={setPhotos} />

          {err && <p className="text-sm text-red-600">{err}</p>}
          {uploadProgress && (
            <p className="text-sm text-slate-600">
              Uploading photos {uploadProgress.done}/{uploadProgress.total}…
            </p>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Link href="/events" className="rounded-[var(--radius)] border border-[#e5e7eb] bg-white px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50">
              Cancel
            </Link>
            <Button type="submit" loading={busy}>
              {recurrence.mode === 'weekly' ? 'Create recurring event' : 'Create event'}
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}

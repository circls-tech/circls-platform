'use client';

import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { isSeriesResult, useCreateEvent } from '@/lib/api/events';
import { useVenues, uploadEventImageFile } from '@/lib/api/queries';
import { useCurrency } from '@/lib/currency';
import { TiersEditor, emptyTier, tiersToPayload, type TierDraft } from '@/components/TiersEditor';
import { MaxPerUserField, maxPerUserToPayload } from '@/components/MaxPerUserField';
import { PendingPhotosPicker, type PendingPhoto } from '@/components/PendingPhotos';
import {
  RecurrenceEditor,
  emptyRecurrence,
  occurrencePayloads,
  type RecurrenceValue,
} from '@/components/RecurrenceEditor';
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
  const createEvent = useCreateEvent(venueId);
  const currency = useCurrency({ venueId });
  // For Advanced-settings venue overrides on recurring events (needs tenantId).
  const { data: venues } = useVenues(tenantId);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [startsAtLocal, setStartsAtLocal] = useState('');
  const [endsAtLocal, setEndsAtLocal] = useState('');
  const [tiers, setTiers] = useState<TierDraft[]>([emptyTier()]);
  // null = no per-customer ticket limit; else the count input's string value.
  const [maxPerUser, setMaxPerUser] = useState<string | null>(null);
  const [photos, setPhotos] = useState<PendingPhoto[]>([]);
  const [recurrence, setRecurrence] = useState<RecurrenceValue>(emptyRecurrence());
  const [err, setErr] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState<{ done: number; total: number } | null>(
    null,
  );

  // Best-effort tz; the venue row owns the source of truth but we keep this
  // page tz-pinned to IST for now (matches the rest of the app's IST UI).
  const tz = 'Asia/Kolkata';
  const busy = createEvent.isPending || uploadProgress !== null;
  const thisVenue = venues?.find((v) => v.id === venueId);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!startsAtLocal || !endsAtLocal) {
      setErr('Set a start and end time.');
      return;
    }
    if (tiers.some((t) => !t.name.trim())) {
      setErr('Give every ticket tier a name.');
      return;
    }

    const isWeekly = recurrence.mode === 'weekly';
    const occurrences = isWeekly
      ? occurrencePayloads(
          recurrence,
          (ovId) => venues?.find((v) => v.id === ovId)?.tzName ?? tz,
          localToVenueTzIso,
        )
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

    try {
      const result = await createEvent.mutateAsync({
        name,
        ...(description ? { description } : {}),
        ...(occurrences
          ? { occurrences }
          : {
              startsAt: localToVenueTzIso(startsAtLocal, tz),
              endsAt: localToVenueTzIso(endsAtLocal, tz),
            }),
        tiers: tiersToPayload(tiers),
        maxPerUser: maxPerUserToPayload(maxPerUser),
      });
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
          router.push(
            `/venues/${venueId}/events/${anchor.id}${tenantId ? `?tenantId=${tenantId}` : ''}`,
          );
          return;
        }
        setUploadProgress(null);
      }
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
      <h1 className="font-[family-name:var(--font-display)] text-2xl font-extrabold tracking-tight text-[#17151D]">New event</h1>

      <Card title="Details" subtitle="Events are created as drafts. Submit for review when you're ready — Circls approves it before it goes live for consumers.">
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

          <RecurrenceEditor
            value={recurrence}
            onChange={setRecurrence}
            baseStartLocal={startsAtLocal}
            baseEndLocal={endsAtLocal}
            venues={(venues ?? []).filter((v) => v.id !== venueId).map((v) => ({ id: v.id, name: v.name }))}
            baseLocationLabel={`Same as event${thisVenue ? ` — ${thisVenue.name}` : ''}`}
            baseTiers={tiers}
            currency={currency}
          />

          <TiersEditor value={tiers} onChange={setTiers} currency={currency} />

          <MaxPerUserField value={maxPerUser} onChange={setMaxPerUser} />

          <PendingPhotosPicker photos={photos} onChange={setPhotos} />

          {err && <p className="text-sm text-red-600">{err}</p>}
          {uploadProgress && (
            <p className="text-sm text-slate-600">
              Uploading photos {uploadProgress.done}/{uploadProgress.total}…
            </p>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Link
              href={`/venues/${venueId}/events${tenantId ? `?tenantId=${tenantId}` : ''}`}
              className="rounded-[var(--radius)] border border-[#e5e7eb] bg-white px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
            >
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

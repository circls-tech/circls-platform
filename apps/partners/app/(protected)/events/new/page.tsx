'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { type FormEvent, Suspense, useEffect, useState } from 'react';
import { useOrg } from '@/lib/org_context';
import { useMyRole, useTenantProfile, useVenues, uploadEventImageFile } from '@/lib/api/queries';
import {
  isSeriesResult,
  useCreateTenantEvent,
  useEvent,
  type CreateTenantEventInput,
} from '@/lib/api/events';
import { useCurrency } from '@/lib/currency';
import { SERVED_COUNTRIES } from '@/lib/countries';
import type { AddressSuggestion } from '@/lib/api/geocode';
import { AddressAutocomplete } from '@/components/AddressAutocomplete';
import { CityDidYouMean } from '@/components/CityDidYouMean';
import { MapPinPicker } from '@/components/MapPinPicker';
import { TiersEditor, emptyTier, tiersToPayload, type TierDraft } from '@/components/TiersEditor';
import { EventQuestionsEditor } from '@/components/EventQuestionsEditor';
import {
  hasChoiceQuestionWithoutOptions,
  questionsToPayload,
  type QuestionDraft,
} from '@/lib/events/questions';
import { duplicateDraftFromEvent } from '@/lib/events/duplicate';
import { MaxPerUserField, maxPerUserToPayload } from '@/components/MaxPerUserField';
import { PendingPhotosPicker, type PendingPhoto } from '@/components/PendingPhotos';
import { RoleNotice } from '@/components/RoleNotice';
import {
  RecurrenceEditor,
  emptyRecurrence,
  occurrencePayloads,
  type RecurrenceValue,
} from '@/components/RecurrenceEditor';
import { QrTicketConfigEditor } from '@/components/QrTicketConfigEditor';
import {
  PostBookingRedirectEditor,
  isValidRedirectUrl,
  redirectToPayload,
} from '@/components/PostBookingRedirectEditor';
import type { PostBookingRedirect, QrTicketConfig, VenueEvent } from '@/lib/api/types';
import { BackLink, Button, Card, Input } from '@/lib/ui';
import { brandOf, scratchEvent } from '@/lib/api/scratch_listing';
import { ScratchPreview } from '@/components/ScratchPreview';

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
  // useSearchParams needs a Suspense boundary on a statically-rendered route.
  return (
    <Suspense fallback={null}>
      <NewTenantEventRoute />
    </Suspense>
  );
}

/**
 * Resolves the tenant and, for `?from=<eventId>` (an event's Duplicate
 * button), loads the event to copy before the form mounts. The form is keyed
 * on tenant + source, so it is born seeded rather than patched after the
 * fact: nothing the organiser types can be overwritten by a late fetch, and
 * switching organisation or dropping `?from` gives a fresh blank form.
 */
function NewTenantEventRoute() {
  const params = useSearchParams();
  const fromId = params.get('from');
  const { activeTenantId } = useOrg();
  // The ?tenantId link param first (venue-scoped pages carry it); without it,
  // the active organisation.
  const tenantId = params.get('tenantId') || activeTenantId || '';
  const { data: source, error: sourceError } = useEvent(tenantId, fromId);

  if (!tenantId) {
    return <p className="text-sm text-slate-500">Select an organization first.</p>;
  }

  const sourcePending = Boolean(fromId) && !source && !sourceError;

  return (
    <div className="flex flex-col gap-6">
      <BackLink href="/events">Events</BackLink>
      <h1 className="font-[family-name:var(--font-display)] text-2xl font-extrabold tracking-tight text-[#17151D]">
        {fromId ? 'Duplicate event' : 'New event'}
      </h1>

      {fromId && (
        <p className="rounded-[var(--radius)] border border-[#e5e7eb] bg-slate-50 px-3 py-2 text-sm text-slate-600">
          {sourceError ? (
            <>Couldn’t load the event to copy ({sourceError.message}) — the form below starts blank.</>
          ) : source ? (
            <>
              Copying <span className="font-medium text-slate-800">{source.name}</span>. Dates,
              recurrence and photos aren’t copied — set new dates below. The copy is saved as a
              separate draft; the original is left as it is.
            </>
          ) : (
            <>Loading the event to copy…</>
          )}
        </p>
      )}

      {!sourcePending && (
        <NewTenantEventForm
          key={`${tenantId}:${source?.id ?? 'blank'}`}
          tenantId={tenantId}
          source={source ?? null}
        />
      )}
    </div>
  );
}

function NewTenantEventForm({
  tenantId,
  source,
}: {
  tenantId: string;
  /** The event to copy, already loaded; null for a blank form. */
  source: VenueEvent | null;
}) {
  const router = useRouter();
  const { data: profile } = useTenantProfile(tenantId);
  const { data: venues } = useVenues(tenantId);
  const createEvent = useCreateTenantEvent(tenantId);
  const { can, isLoading: roleLoading } = useMyRole(tenantId);
  // Seeded once, on mount — the route remounts this form whenever the source
  // changes, so there is no later patch to race the organiser's edits.
  const [seed] = useState(() => (source ? duplicateDraftFromEvent(source) : null));

  const [scope, setScope] = useState<Scope>(seed?.scope ?? 'venue');
  const [venueId, setVenueId] = useState(seed?.venueId ?? '');
  const [name, setName] = useState(seed?.name ?? '');
  const [description, setDescription] = useState(seed?.description ?? '');
  const [startsAtLocal, setStartsAtLocal] = useState('');
  const [endsAtLocal, setEndsAtLocal] = useState('');
  // The customer-site preview of the form as it stands (nothing saved).
  const [previewOpen, setPreviewOpen] = useState(false);
  // The page is meaningless without a name and a start; the rest may be blank.
  const canPreview = name.trim().length > 0 && startsAtLocal.length > 0;
  useEffect(() => {
    if (!canPreview) setPreviewOpen(false);
  }, [canPreview]);
  const [tiers, setTiers] = useState<TierDraft[]>(seed?.tiers ?? [emptyTier()]);
  const [questions, setQuestions] = useState<QuestionDraft[]>(seed?.questions ?? []);
  const [qrConfig, setQrConfig] = useState<QrTicketConfig | null>(seed?.qrConfig ?? null);
  // null = no per-customer ticket limit; else the count input's string value.
  const [maxPerUser, setMaxPerUser] = useState<string | null>(seed?.maxPerUser ?? null);
  const [redirect, setRedirect] = useState<PostBookingRedirect | null>(seed?.redirect ?? null);
  const [photos, setPhotos] = useState<PendingPhoto[]>([]);
  const [recurrence, setRecurrence] = useState<RecurrenceValue>(emptyRecurrence());
  const [uploadProgress, setUploadProgress] = useState<{ done: number; total: number } | null>(
    null,
  );
  const [line1, setLine1] = useState(seed?.address.line1 ?? '');
  const [line2, setLine2] = useState(seed?.address.line2 ?? '');
  const [city, setCity] = useState(seed?.address.city ?? '');
  const [stateRegion, setStateRegion] = useState(seed?.address.state ?? '');
  const [pincode, setPincode] = useState(seed?.address.pincode ?? '');
  const [country, setCountry] = useState(seed?.address.country ?? '');
  const [tz, setTz] = useState(seed?.address.tz ?? 'Asia/Kolkata');
  // Coordinates are held here (never shown) — set from an autocomplete pick and
  // cleared on any manual address edit so the server geocodes from the typed
  // address on create. Organisers never enter lat/lng by hand.
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(
    seed?.address.coords ?? null,
  );
  const [err, setErr] = useState<string | null>(null);

  const selectedVenue = venues?.find((v) => v.id === venueId);
  const effectiveTz = scope === 'venue' ? selectedVenue?.tzName ?? 'Asia/Kolkata' : tz;
  // Ticket prices follow the venue's currency, or the standalone address's
  // country (tenant currency until one is picked).
  const currency = useCurrency({
    venueId: scope === 'venue' ? venueId || null : null,
    country: scope === 'standalone' ? country || null : null,
  });
  const busy = createEvent.isPending || uploadProgress !== null;

  /** Fill the address fields + coordinates from a chosen autocomplete result. */
  function applySuggestion(s: AddressSuggestion) {
    if (s.line1) setLine1(s.line1);
    setCity(s.city ?? '');
    setStateRegion(s.state ?? '');
    if (s.postalCode) setPincode(s.postalCode);
    if (s.country) setCountry(s.country);
    setCoords({ lat: s.lat, lng: s.lng });
  }

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
    if (hasChoiceQuestionWithoutOptions(questions)) {
      setErr('Give every choice question at least 2 options.');
      return;
    }
    if (redirect && redirect.url.trim() && !isValidRedirectUrl(redirect.url)) {
      setErr('Enter a full http:// or https:// link for the after-booking step.');
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
      questions: questionsToPayload(questions),
      maxPerUser: maxPerUserToPayload(maxPerUser),
      qrTicketConfig: qrConfig,
      postBookingRedirect: redirectToPayload(redirect),
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
      if (country.trim()) addressJson.country = country.trim();
      // Coordinates come from an autocomplete pick when available; otherwise
      // they're omitted and the API derives them from the address (its geocoder).
      input = {
        ...base,
        addressJson,
        tzName: tz,
        ...(coords ? { lat: coords.lat, lng: coords.lng } : {}),
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

  // Only once the role is known, so Owners and Managers never see it flash up.
  if (!roleLoading && !can('events.write')) {
    return <RoleNotice>Your role can’t create events — Owners and Managers can.</RoleNotice>;
  }

  return (
    <div className={previewOpen ? 'xl:pr-[var(--scratch-preview-w)]' : ''}>
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
              <AddressAutocomplete country={country || null} onSelect={applySuggestion} />
              <Input label="Address line 1" value={line1} onChange={(e) => { setLine1(e.target.value); setCoords(null); }} placeholder="Street / building" />
              <Input label="Address line 2" value={line2} onChange={(e) => setLine2(e.target.value)} placeholder="Optional" />
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="flex flex-col gap-1">
                  <Input label="City" value={city} onChange={(e) => { setCity(e.target.value); setCoords(null); }} />
                  <CityDidYouMean city={city} country={country || null} onPick={(c) => { setCity(c); setCoords(null); }} />
                </div>
                <Input label="State" value={stateRegion} onChange={(e) => { setStateRegion(e.target.value); setCoords(null); }} />
                <Input label="PIN" value={pincode} onChange={(e) => { setPincode(e.target.value); setCoords(null); }} />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="flex flex-col gap-1">
                  <label className="text-xs font-medium uppercase tracking-wide text-[#475569]">Country</label>
                  <select
                    value={country}
                    onChange={(e) => { setCountry(e.target.value); setCoords(null); }}
                    className="w-full rounded-[var(--radius)] border border-[#e5e7eb] bg-white px-3 py-2 text-sm text-[#0f172a] hover:border-slate-300"
                  >
                    <option value="">Select country…</option>
                    {SERVED_COUNTRIES.map((c) => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                  <span className="text-xs text-slate-400">
                    Sets the map pin automatically and the currency tickets sell in.
                  </span>
                </div>
                <Input label="Timezone" value={tz} onChange={(e) => setTz(e.target.value)} hint="IANA tz, e.g. Asia/Kolkata" />
              </div>
              <MapPinPicker coords={coords} onChange={setCoords} city={city} country={country} />
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

          <EventQuestionsEditor value={questions} onChange={setQuestions} />

          <MaxPerUserField value={maxPerUser} onChange={setMaxPerUser} />

          <QrTicketConfigEditor value={qrConfig} onChange={setQrConfig} itemNoun="event" />

          <PostBookingRedirectEditor value={redirect} onChange={setRedirect} />

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
            <Button
              type="button"
              variant="secondary"
              disabled={!canPreview}
              title={canPreview ? undefined : 'Enter a name and a start time to preview'}
              onClick={() => setPreviewOpen((v) => !v)}
            >
              {previewOpen ? 'Hide preview' : 'Preview'}
            </Button>
            <Button type="submit" loading={busy}>
              {recurrence.mode === 'weekly' ? 'Create recurring event' : 'Create event'}
            </Button>
          </div>
        </form>
      </Card>
      <ScratchPreview
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        tenantId={tenantId}
        type="event"
        listing={scratchEvent({
          tenantId,
          brand: brandOf(tenantId, profile),
          name,
          description,
          startsAt: startsAtLocal ? localToTzIso(startsAtLocal, effectiveTz) : '',
          endsAt: endsAtLocal ? localToTzIso(endsAtLocal, effectiveTz) : '',
          tiers,
          maxPerUser: maxPerUserToPayload(maxPerUser),
          venue: scope === 'venue' ? selectedVenue : null,
          ...(scope === 'standalone'
            ? { address: { line1, line2, city, state: stateRegion, pincode, country } }
            : {}),
          tz: effectiveTz,
        })}
        files={photos.map((p) => p.file)}
      />
    </div>
  );
}

'use client';

import { type FormEvent, useState } from 'react';
import type { VenueEvent } from '@/lib/api/types';
import {
  useCreateEventChangeRequest,
  useEventChangeRequests,
  useWithdrawEventChangeRequest,
  type EventChangeRequestInput,
} from '@/lib/api/events';
import { useVenues } from '@/lib/api/queries';
import { useCurrency } from '@/lib/currency';
import { SERVED_COUNTRIES } from '@/lib/countries';
import type { AddressSuggestion } from '@/lib/api/geocode';
import { AddressAutocomplete } from '@/components/AddressAutocomplete';
import { CityDidYouMean } from '@/components/CityDidYouMean';
import { MapPinPicker } from '@/components/MapPinPicker';
import {
  TiersEditor,
  tierDraftFromApi,
  tiersToChangeRequestPayload,
  type TierDraft,
} from '@/components/TiersEditor';
import { Button, Card, Input } from '@/lib/ui';

/** Friendly labels for the patch keys shown in the pending banner. */
const FIELD_LABELS: Record<string, string> = {
  name: 'Name',
  startsAt: 'Date & time',
  endsAt: 'Date & time',
  venueId: 'Location',
  addressJson: 'Location',
  lat: 'Location',
  lng: 'Location',
  tzName: 'Location',
  tiers: 'Ticket tiers',
};

function friendlyFields(patch: EventChangeRequestInput): string[] {
  const labels = Object.keys(patch)
    .filter((k) => patch[k as keyof EventChangeRequestInput] !== undefined)
    .map((k) => FIELD_LABELS[k] ?? k);
  return [...new Set(labels)];
}

/** Convert a `datetime-local` value (interpreted in `tzName`) to UTC ISO. */
function localToTzIso(local: string, tzName: string): string {
  if (!local) return '';
  const asIfUtc = new Date(`${local}:00Z`);
  const wall = new Intl.DateTimeFormat('en-CA', {
    timeZone: tzName,
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

/** Convert a UTC ISO string into a `datetime-local` value in `tzName`. */
function isoToTzLocal(iso: string, tzName: string): string {
  if (!iso) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tzName,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(iso));
  const [datePart, timePart] = parts.split(', ');
  return `${datePart}T${timePart.slice(0, 5)}`;
}

/**
 * The approval flow for a PUBLISHED event's protected fields — name, date &
 * time, location, and ticket tiers. The partner proposes the change here; it
 * applies only after the circls team approves it. One pending request per
 * event; a pending request can be withdrawn to submit a different one.
 * (The freely-editable live settings live in LiveEventSettings above.)
 */
export function EventChangeRequests({ tenantId, ev }: { tenantId: string; ev: VenueEvent }) {
  const { data: requests } = useEventChangeRequests(tenantId, ev.id);
  const create = useCreateEventChangeRequest(tenantId);
  const withdraw = useWithdrawEventChangeRequest(tenantId);
  const { data: venues } = useVenues(tenantId);

  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form state, seeded from the event when the form opens.
  const [name, setName] = useState('');
  const [startsAtLocal, setStartsAtLocal] = useState('');
  const [endsAtLocal, setEndsAtLocal] = useState('');
  const [tiers, setTiers] = useState<TierDraft[]>([]);
  // '' => standalone; otherwise a venue id.
  const [venueChoice, setVenueChoice] = useState('');
  const [line1, setLine1] = useState('');
  const [line2, setLine2] = useState('');
  const [city, setCity] = useState('');
  const [stateRegion, setStateRegion] = useState('');
  const [pincode, setPincode] = useState('');
  const [countryForm, setCountryForm] = useState('');
  // Set from an autocomplete pick / map pin; cleared on manual edits so the
  // server re-geocodes from the typed address on approval.
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [tzForm, setTzForm] = useState('Asia/Kolkata');

  const pending = requests?.rows.find((r) => r.status === 'pending');
  const latest = requests?.rows[0];

  const currentVenue = ev.venueId ? venues?.find((v) => v.id === ev.venueId) : undefined;
  const eventTz = ev.venueId ? (currentVenue?.tzName ?? 'Asia/Kolkata') : (ev.tzName ?? 'Asia/Kolkata');
  const selectedVenue = venueChoice ? venues?.find((v) => v.id === venueChoice) : undefined;
  const editTz = venueChoice === '' ? tzForm : (selectedVenue?.tzName ?? 'Asia/Kolkata');

  // Tier prices follow the proposed scope's currency as the form changes.
  const formCurrency = useCurrency({
    venueId: venueChoice || null,
    country: venueChoice ? null : countryForm || null,
  });

  function openForm() {
    setName(ev.name);
    setStartsAtLocal(isoToTzLocal(ev.startsAt, eventTz));
    setEndsAtLocal(isoToTzLocal(ev.endsAt, eventTz));
    // Keep tier ids so the API updates live tiers in place (sold tickets stay
    // attached); a row added in the editor has no id and becomes a new tier.
    setTiers(ev.tiers.map(tierDraftFromApi));
    setVenueChoice(ev.venueId ?? '');
    const addr = (ev.addressJson ?? {}) as Record<string, unknown>;
    const str = (k: string) => (typeof addr[k] === 'string' ? (addr[k] as string) : '');
    setLine1(str('line1'));
    setLine2(str('line2'));
    setCity(str('city'));
    setStateRegion(str('state'));
    setPincode(str('pincode'));
    setCountryForm(str('country'));
    setCoords(ev.lat != null && ev.lng != null ? { lat: ev.lat, lng: ev.lng } : null);
    setTzForm(ev.tzName ?? 'Asia/Kolkata');
    setError(null);
    setOpen(true);
  }

  function applySuggestion(s: AddressSuggestion) {
    if (s.line1) setLine1(s.line1);
    setCity(s.city ?? '');
    setStateRegion(s.state ?? '');
    if (s.postalCode) setPincode(s.postalCode);
    if (s.country) setCountryForm(s.country);
    setCoords({ lat: s.lat, lng: s.lng });
  }

  function buildAddressJson(): Record<string, unknown> {
    const a: Record<string, unknown> = {};
    if (line1.trim()) a.line1 = line1.trim();
    if (line2.trim()) a.line2 = line2.trim();
    if (city.trim()) a.city = city.trim();
    if (stateRegion.trim()) a.state = stateRegion.trim();
    if (pincode.trim()) a.pincode = pincode.trim();
    if (countryForm.trim()) a.country = countryForm.trim();
    return a;
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) {
      setError('The event needs a name.');
      return;
    }
    if (!startsAtLocal || !endsAtLocal) {
      setError('Set a start and end time.');
      return;
    }
    if (tiers.some((t) => !t.name.trim())) {
      setError('Give every ticket tier a name.');
      return;
    }

    const input: EventChangeRequestInput = {};
    if (name.trim() !== ev.name) input.name = name.trim();

    const startsAt = localToTzIso(startsAtLocal, editTz);
    const endsAt = localToTzIso(endsAtLocal, editTz);
    if (startsAt !== ev.startsAt) input.startsAt = startsAt;
    if (endsAt !== ev.endsAt) input.endsAt = endsAt;

    const originalChoice = ev.venueId ?? '';
    const scopeChanged = venueChoice !== originalChoice;
    if (venueChoice === '') {
      const addressJson = buildAddressJson();
      if (Object.keys(addressJson).length === 0) {
        setError('Enter an address for a standalone event.');
        return;
      }
      if (!tzForm.trim()) {
        setError('Enter a timezone for a standalone event.');
        return;
      }
      const addressChanged =
        JSON.stringify(addressJson) !== JSON.stringify(ev.addressJson ?? {}) ||
        tzForm.trim() !== (ev.tzName ?? '');
      if (scopeChanged || addressChanged) {
        input.addressJson = addressJson;
        input.tzName = tzForm.trim();
        if (coords) {
          input.lat = coords.lat;
          input.lng = coords.lng;
        }
        if (scopeChanged) input.venueId = null;
      }
    } else if (scopeChanged) {
      input.venueId = venueChoice;
    }

    const originalTiers = tiersToChangeRequestPayload(ev.tiers.map(tierDraftFromApi));
    const proposedTiers = tiersToChangeRequestPayload(tiers);
    if (JSON.stringify(proposedTiers) !== JSON.stringify(originalTiers)) {
      input.tiers = proposedTiers;
    }

    if (Object.keys(input).length === 0) {
      setError('Nothing has changed.');
      return;
    }

    try {
      await create.mutateAsync({ eventId: ev.id, input });
      setOpen(false);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <Card title="Request changes">
      <p className="mb-4 text-xs text-slate-500">
        The name, date &amp; time, location, and ticket tiers of a live event change only after the
        circls team approves the request — what people already booked stays protected. One request
        can be open at a time.
      </p>

      {pending && (
        <div className="mb-3 flex flex-col gap-2 rounded border border-amber-200 bg-amber-50 px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-amber-800">
            Changes submitted — awaiting circls review:{' '}
            <span className="font-medium">{friendlyFields(pending.patch).join(', ')}</span>
          </p>
          <Button
            variant="secondary"
            size="sm"
            loading={withdraw.isPending}
            onClick={() => {
              setError(null);
              withdraw.mutate(
                { eventId: ev.id, requestId: pending.id },
                { onError: (e) => setError((e as Error).message) },
              );
            }}
          >
            Withdraw
          </Button>
        </div>
      )}

      {!pending && latest?.status === 'rejected' && (
        <p className="mb-3 rounded border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
          Your last request ({friendlyFields(latest.patch).join(', ')}) was declined
          {latest.reason ? <>: &ldquo;{latest.reason}&rdquo;</> : '.'} You can submit a new one.
        </p>
      )}

      {!pending && latest?.status === 'approved' && !open && (
        <p className="mb-3 text-xs text-emerald-600">
          Your last request ({friendlyFields(latest.patch).join(', ')}) was approved and applied.
        </p>
      )}

      {error && (
        <p className="mb-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
          {error}
        </p>
      )}

      {!pending && !open && (
        <Button variant="secondary" size="sm" onClick={openForm}>
          Request changes
        </Button>
      )}

      {!pending && open && (
        <form onSubmit={onSubmit} className="flex max-w-2xl flex-col gap-4">
          <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} required />

          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium uppercase tracking-wide text-[#475569]">
              Venue
            </label>
            <select
              value={venueChoice}
              onChange={(e) => setVenueChoice(e.target.value)}
              className="w-full rounded-[var(--radius)] border border-[#e5e7eb] bg-white px-3 py-2 text-sm text-[#0f172a] hover:border-slate-300"
            >
              <option value="">Standalone (no venue) — enter address</option>
              {venues?.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
            <p className="text-xs text-slate-400">
              Assigning a venue uses that venue&apos;s location. Times are in {editTz}.
            </p>
          </div>

          {venueChoice === '' && (
            <div className="flex flex-col gap-3 rounded-[var(--radius)] border border-[#e5e7eb] bg-slate-50 p-3">
              <AddressAutocomplete country={countryForm || null} onSelect={applySuggestion} />
              <Input
                label="Address line 1"
                value={line1}
                onChange={(e) => {
                  setLine1(e.target.value);
                  setCoords(null);
                }}
                placeholder="Street / building"
              />
              <Input
                label="Address line 2"
                value={line2}
                onChange={(e) => setLine2(e.target.value)}
                placeholder="Optional"
              />
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div className="flex flex-col gap-1">
                  <Input
                    label="City"
                    value={city}
                    onChange={(e) => {
                      setCity(e.target.value);
                      setCoords(null);
                    }}
                  />
                  <CityDidYouMean
                    city={city}
                    country={countryForm || null}
                    onPick={(c) => {
                      setCity(c);
                      setCoords(null);
                    }}
                  />
                </div>
                <Input
                  label="State"
                  value={stateRegion}
                  onChange={(e) => {
                    setStateRegion(e.target.value);
                    setCoords(null);
                  }}
                />
                <Input
                  label="PIN"
                  value={pincode}
                  onChange={(e) => {
                    setPincode(e.target.value);
                    setCoords(null);
                  }}
                />
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="flex flex-col gap-1">
                  <label className="text-xs font-medium uppercase tracking-wide text-[#475569]">
                    Country
                  </label>
                  <select
                    value={countryForm}
                    onChange={(e) => {
                      setCountryForm(e.target.value);
                      setCoords(null);
                    }}
                    className="w-full rounded-[var(--radius)] border border-[#e5e7eb] bg-white px-3 py-2 text-sm text-[#0f172a] hover:border-slate-300"
                  >
                    <option value="">Select country…</option>
                    {SERVED_COUNTRIES.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </div>
                <Input
                  label="Timezone"
                  value={tzForm}
                  onChange={(e) => setTzForm(e.target.value)}
                  hint="IANA tz, e.g. Asia/Kolkata"
                />
              </div>
              <MapPinPicker coords={coords} onChange={setCoords} city={city} country={countryForm} />
            </div>
          )}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Input
              label={`Starts (${editTz})`}
              type="datetime-local"
              value={startsAtLocal}
              onChange={(e) => setStartsAtLocal(e.target.value)}
              required
            />
            <Input
              label={`Ends (${editTz})`}
              type="datetime-local"
              value={endsAtLocal}
              onChange={(e) => setEndsAtLocal(e.target.value)}
              required
            />
          </div>

          <TiersEditor value={tiers} onChange={setTiers} currency={formCurrency} />
          <p className="text-xs text-slate-400">
            Tiers with registrations can&apos;t be removed, and their capacity can&apos;t go below
            tickets already sold.
          </p>

          <div className="flex justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setOpen(false);
                setError(null);
              }}
            >
              Cancel
            </Button>
            <Button type="submit" loading={create.isPending}>
              Submit for approval
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}

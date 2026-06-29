'use client';

import { type FormEvent, useState } from 'react';
import { useUpdateVenue } from '@/lib/api/queries';
import type { OpeningHours, Venue } from '@/lib/api/types';
import { Button, Input, TagsInput } from '@/lib/ui';

/**
 * Canonical amenity vocabulary — must mirror VENUE_AMENITIES in
 * apps/api/src/lib/venue_metadata.ts (the API validates against it).
 */
const AMENITIES: { value: string; label: string }[] = [
  { value: 'parking', label: 'Parking' },
  { value: 'restrooms', label: 'Restrooms' },
  { value: 'changing_rooms', label: 'Changing rooms' },
  { value: 'showers', label: 'Showers' },
  { value: 'drinking_water', label: 'Drinking water' },
  { value: 'cafe', label: 'Café' },
  { value: 'equipment_rental', label: 'Equipment rental' },
  { value: 'first_aid', label: 'First aid' },
  { value: 'wifi', label: 'Wi-Fi' },
  { value: 'lockers', label: 'Lockers' },
  { value: 'seating', label: 'Seating' },
  { value: 'floodlights', label: 'Floodlights' },
  { value: 'air_conditioning', label: 'Air conditioning' },
  { value: 'wheelchair_accessible', label: 'Wheelchair accessible' },
  { value: 'pro_shop', label: 'Pro shop' },
  { value: 'coaching', label: 'Coaching' },
];

const WEEKDAYS = [
  { key: '1', label: 'Monday' },
  { key: '2', label: 'Tuesday' },
  { key: '3', label: 'Wednesday' },
  { key: '4', label: 'Thursday' },
  { key: '5', label: 'Friday' },
  { key: '6', label: 'Saturday' },
  { key: '0', label: 'Sunday' },
];

type DayState = { closed: boolean; open: string; close: string };

function toDayState(hours: OpeningHours | null | undefined): Record<string, DayState> {
  const out: Record<string, DayState> = {};
  for (const { key } of WEEKDAYS) {
    const ranges = hours?.[key];
    const first = ranges && ranges.length > 0 ? ranges[0]! : null;
    out[key] = first
      ? { closed: false, open: first.open, close: first.close }
      : { closed: true, open: '09:00', close: '22:00' };
  }
  return out;
}

function fromDayState(state: Record<string, DayState>): OpeningHours {
  const out: OpeningHours = {};
  for (const { key } of WEEKDAYS) {
    const d = state[key]!;
    out[key] = d.closed ? [] : [{ open: d.open, close: d.close }];
  }
  return out;
}

/**
 * Editable trust-metadata panel for a venue (PR #109): name, description,
 * amenities (chips), weekly opening hours, contact, structured address, tags and
 * map location. Wires the existing (previously UI-less) PATCH /v1/venues/:id.
 */
export function VenueDetailsForm({ venue }: { venue: Venue }) {
  const update = useUpdateVenue(venue.id);

  const [name, setName] = useState(venue.name);
  const [description, setDescription] = useState(venue.description ?? '');
  const [amenities, setAmenities] = useState<string[]>(venue.amenities ?? []);
  const [hours, setHours] = useState<Record<string, DayState>>(toDayState(venue.openingHours));
  const [contactPhone, setContactPhone] = useState(venue.contactPhone ?? '');
  const [contactEmail, setContactEmail] = useState(venue.contactEmail ?? '');
  const [addressLine1, setAddressLine1] = useState(venue.addressLine1 ?? '');
  const [addressLine2, setAddressLine2] = useState(venue.addressLine2 ?? '');
  const [city, setCity] = useState(venue.city ?? '');
  const [state, setState] = useState(venue.state ?? '');
  const [postalCode, setPostalCode] = useState(venue.postalCode ?? '');
  const [country, setCountry] = useState(venue.country ?? '');
  const [tags, setTags] = useState<string[]>(venue.tags ?? []);
  const [lat, setLat] = useState(venue.lat != null ? String(venue.lat) : '');
  const [lng, setLng] = useState(venue.lng != null ? String(venue.lng) : '');

  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function toggleAmenity(value: string) {
    setAmenities((prev) => (prev.includes(value) ? prev.filter((a) => a !== value) : [...prev, value]));
  }

  function setDay(key: string, patch: Partial<DayState>) {
    setHours((prev) => ({ ...prev, [key]: { ...prev[key]!, ...patch } }));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    setSaved(false);
    const latNum = lat.trim() === '' ? null : Number(lat);
    const lngNum = lng.trim() === '' ? null : Number(lng);
    if (latNum != null && Number.isNaN(latNum)) return setErr('Latitude must be a number.');
    if (lngNum != null && Number.isNaN(lngNum)) return setErr('Longitude must be a number.');
    try {
      await update.mutateAsync({
        name: name.trim(),
        description,
        amenities,
        openingHours: fromDayState(hours),
        contactPhone,
        contactEmail,
        addressLine1,
        addressLine2,
        city,
        state,
        postalCode,
        country,
        tags,
        lat: latNum,
        lng: lngNum,
      });
      setSaved(true);
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-5 rounded border border-gray-200 bg-white p-4"
    >
      <div>
        <h2 className="font-medium">Venue details</h2>
        <p className="text-xs text-gray-400">
          What customers see on your venue page. Keep it accurate — stale details erode trust.
        </p>
      </div>

      <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} required />

      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium uppercase tracking-wide text-[#475569]">Description</label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={4}
          maxLength={2000}
          className="w-full rounded-[var(--radius)] border border-[#e5e7eb] bg-white px-3 py-2 text-sm text-[#0f172a] placeholder:text-[#94a3b8] hover:border-slate-300"
          placeholder="Describe the venue, its facilities and what makes it great."
        />
      </div>

      <div className="flex flex-col gap-2">
        <label className="text-xs font-medium uppercase tracking-wide text-[#475569]">Amenities</label>
        <div className="flex flex-wrap gap-2">
          {AMENITIES.map((a) => {
            const on = amenities.includes(a.value);
            return (
              <button
                key={a.value}
                type="button"
                onClick={() => toggleAmenity(a.value)}
                className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                  on
                    ? 'border-blue-500 bg-blue-50 text-blue-700'
                    : 'border-gray-200 bg-white text-slate-600 hover:bg-slate-50'
                }`}
              >
                {a.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <label className="text-xs font-medium uppercase tracking-wide text-[#475569]">Opening hours</label>
        <div className="flex flex-col gap-1.5">
          {WEEKDAYS.map(({ key, label }) => {
            const d = hours[key]!;
            return (
              <div key={key} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="w-24 text-slate-600">{label}</span>
                <label className="flex items-center gap-1 text-xs text-slate-500">
                  <input
                    type="checkbox"
                    checked={d.closed}
                    onChange={(e) => setDay(key, { closed: e.target.checked })}
                  />
                  Closed
                </label>
                {!d.closed && (
                  <>
                    <input
                      type="time"
                      value={d.open}
                      onChange={(e) => setDay(key, { open: e.target.value })}
                      className="rounded border border-gray-300 px-2 py-1 text-sm"
                    />
                    <span className="text-slate-400">to</span>
                    <input
                      type="time"
                      value={d.close}
                      onChange={(e) => setDay(key, { close: e.target.value })}
                      className="rounded border border-gray-300 px-2 py-1 text-sm"
                    />
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Input label="Contact phone" value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} />
        <Input label="Contact email" type="email" value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} />
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <Input label="Address line 1" value={addressLine1} onChange={(e) => setAddressLine1(e.target.value)} />
        </div>
        <div className="sm:col-span-2">
          <Input label="Address line 2" value={addressLine2} onChange={(e) => setAddressLine2(e.target.value)} />
        </div>
        <Input label="City" value={city} onChange={(e) => setCity(e.target.value)} />
        <Input label="State" value={state} onChange={(e) => setState(e.target.value)} />
        <Input label="Postal code" value={postalCode} onChange={(e) => setPostalCode(e.target.value)} />
        <Input label="Country" value={country} onChange={(e) => setCountry(e.target.value)} />
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium uppercase tracking-wide text-[#475569]">Tags</label>
        <TagsInput value={tags} onChange={setTags} placeholder="e.g. indoor, premium…" />
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Input label="Latitude" value={lat} onChange={(e) => setLat(e.target.value)} hint="Map location (optional)" />
        <Input label="Longitude" value={lng} onChange={(e) => setLng(e.target.value)} />
      </div>

      <div className="flex items-center gap-3">
        <Button type="submit" loading={update.isPending}>
          Save details
        </Button>
        {saved && <span className="text-sm text-emerald-600">Saved.</span>}
        {err && <span className="text-sm text-red-600">{err}</span>}
      </div>
    </form>
  );
}

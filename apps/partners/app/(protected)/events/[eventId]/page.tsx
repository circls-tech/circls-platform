'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { useAuth } from '@/lib/firebase/auth_context';
import { useOrg } from '@/lib/org_context';
import {
  useCancelTenantEvent,
  useEvent,
  useEventBookings,
  usePublishTenantEvent,
  useUpdateTenantEvent,
} from '@/lib/api/events';
import { useVenues } from '@/lib/api/queries';
import { EventImages } from '@/components/EventImages';
import {
  TiersEditor,
  emptyTier,
  tierDraftFromApi,
  tiersToPayload,
  type TierDraft,
} from '@/components/TiersEditor';
import { useTimezone } from '@/lib/timezone_context';
import { Badge, Button, Card, Input, StatusPill } from '@/lib/ui';

/** Display a UTC instant in the given zone (the event's own tz, or the
 *  portal-wide viewing tz when overridden). Display only — event scheduling
 *  still round-trips through the venue tz via localToTzIso/isoToTzLocal. */
function fmt(iso: string, tz: string) {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: tz,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

/**
 * Convert a `<input type="datetime-local">` value (interpreted in `tzName`) into
 * a UTC ISO string. Mirrors the venue event pages so edits round-trip through
 * the same tz convention.
 */
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

export default function OrgEventDetailPage() {
  const { eventId } = useParams<{ eventId: string }>();
  const { activeTenantId } = useOrg();
  const tenantId = activeTenantId ?? '';
  const { user } = useAuth();
  const authed = Boolean(user);

  const { data: ev, isLoading } = useEvent(tenantId, eventId);
  const { data: venues } = useVenues(tenantId);
  const { data: bookings, isLoading: bookingsLoading } = useEventBookings(tenantId, eventId);
  const publish = usePublishTenantEvent(tenantId);
  const cancel = useCancelTenantEvent(tenantId);
  const update = useUpdateTenantEvent(tenantId);

  const [editing, setEditing] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Edit form state.
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [startsAtLocal, setStartsAtLocal] = useState('');
  const [endsAtLocal, setEndsAtLocal] = useState('');
  const [tiers, setTiers] = useState<TierDraft[]>([emptyTier()]);
  // '' => standalone; otherwise a venue id.
  const [venueChoice, setVenueChoice] = useState('');
  // Standalone address fields (shown when venueChoice === '').
  const [line1, setLine1] = useState('');
  const [line2, setLine2] = useState('');
  const [city, setCity] = useState('');
  const [stateRegion, setStateRegion] = useState('');
  const [pincode, setPincode] = useState('');
  const [latRaw, setLatRaw] = useState('');
  const [lngRaw, setLngRaw] = useState('');
  const [tzForm, setTzForm] = useState('Asia/Kolkata');

  const { resolveTz } = useTimezone();
  const currentVenue = ev?.venueId ? venues?.find((v) => v.id === ev.venueId) : undefined;
  const eventTz = ev?.venueId ? (currentVenue?.tzName ?? 'Asia/Kolkata') : (ev?.tzName ?? 'Asia/Kolkata');
  // The zone times are DISPLAYED in: the event's own zone, or the portal-wide
  // viewing tz when the user overrides it from the top bar.
  const effectiveTz = resolveTz(eventTz);
  const venueLabel = ev?.venueId
    ? (currentVenue?.name ?? 'Venue')
    : 'Standalone (no venue)';

  // Timezone the datetime-local inputs are interpreted in: a chosen venue's tz,
  // or the standalone tz field. Derived so it follows the venue selector live.
  const selectedEditVenue = venueChoice ? venues?.find((v) => v.id === venueChoice) : undefined;
  const editTz = venueChoice === '' ? tzForm : (selectedEditVenue?.tzName ?? 'Asia/Kolkata');

  function startEdit() {
    if (!ev) return;
    // Populate the datetime-local inputs in the event's OWN zone (not the
    // viewing override) so they round-trip correctly through localToTzIso on save.
    const tz = eventTz;
    setName(ev.name);
    setDescription(ev.description ?? '');
    setStartsAtLocal(isoToTzLocal(ev.startsAt, tz));
    setEndsAtLocal(isoToTzLocal(ev.endsAt, tz));
    setTiers(ev.tiers.length > 0 ? ev.tiers.map(tierDraftFromApi) : [emptyTier()]);
    setVenueChoice(ev.venueId ?? '');
    // Prefill the standalone address from whatever the event already carries.
    const addr = (ev.addressJson ?? {}) as Record<string, unknown>;
    const str = (k: string) => (typeof addr[k] === 'string' ? (addr[k] as string) : '');
    setLine1(str('line1'));
    setLine2(str('line2'));
    setCity(str('city'));
    setStateRegion(str('state'));
    setPincode(str('pincode'));
    setLatRaw(ev.lat != null ? String(ev.lat) : '');
    setLngRaw(ev.lng != null ? String(ev.lng) : '');
    setTzForm(ev.tzName ?? 'Asia/Kolkata');
    setErrorMsg(null);
    setEditing(true);
  }

  async function handlePublish() {
    setErrorMsg(null);
    try {
      await publish.mutateAsync(eventId);
    } catch (e) {
      setErrorMsg((e as Error).message);
    }
  }

  async function handleCancel() {
    setErrorMsg(null);
    try {
      await cancel.mutateAsync(eventId);
    } catch (e) {
      setErrorMsg((e as Error).message);
    }
  }

  function buildAddressJson(): Record<string, unknown> {
    const a: Record<string, unknown> = {};
    if (line1.trim()) a.line1 = line1.trim();
    if (line2.trim()) a.line2 = line2.trim();
    if (city.trim()) a.city = city.trim();
    if (stateRegion.trim()) a.state = stateRegion.trim();
    if (pincode.trim()) a.pincode = pincode.trim();
    return a;
  }

  async function onSubmitEdit(e: FormEvent) {
    e.preventDefault();
    setErrorMsg(null);
    if (!startsAtLocal || !endsAtLocal) {
      setErrorMsg('Set a start and end time.');
      return;
    }
    if (tiers.some((t) => !t.name.trim())) {
      setErrorMsg('Give every ticket tier a name.');
      return;
    }

    const originalChoice = ev?.venueId ?? '';
    const scopeChanged = venueChoice !== originalChoice;

    // Build the scope/address portion of the patch.
    let scopePatch: {
      venueId?: string | null;
      addressJson?: Record<string, unknown>;
      tzName?: string;
      lat?: number | null;
      lng?: number | null;
    } = {};
    if (venueChoice === '') {
      // Standalone (becoming or staying): require an address + tz, send them.
      const addressJson = buildAddressJson();
      if (Object.keys(addressJson).length === 0) {
        setErrorMsg('Enter an address for a standalone event.');
        return;
      }
      if (!tzForm.trim()) {
        setErrorMsg('Enter a timezone for a standalone event.');
        return;
      }
      scopePatch = {
        addressJson,
        tzName: tzForm.trim(),
        lat: latRaw ? parseFloat(latRaw) : null,
        lng: lngRaw ? parseFloat(lngRaw) : null,
        ...(scopeChanged ? { venueId: null } : {}),
      };
    } else if (scopeChanged) {
      // Assigning/reassigning to a venue.
      scopePatch = { venueId: venueChoice };
    }

    try {
      await update.mutateAsync({
        eventId,
        input: {
          name,
          description,
          startsAt: localToTzIso(startsAtLocal, editTz),
          endsAt: localToTzIso(endsAtLocal, editTz),
          tiers: tiersToPayload(tiers),
          ...scopePatch,
        },
      });
      setEditing(false);
    } catch (e) {
      setErrorMsg((e as Error).message);
    }
  }

  const backHref = '/events';

  return (
    <div className="flex flex-col gap-6">
      <Link href={backHref} className="text-sm text-slate-500 hover:text-slate-800 transition-colors">
        &larr; Events
      </Link>

      {isLoading && <p className="py-6 text-center text-sm text-slate-400">Loading…</p>}

      {!isLoading && !ev && (
        <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
          Event not found.
        </p>
      )}

      {errorMsg && (
        <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
          {errorMsg}
        </p>
      )}

      {ev && (
        <>
          <div className="flex items-center justify-between gap-3">
            <h1 className="text-xl font-semibold text-[#0f172a]">{ev.name}</h1>
            <div className="flex items-center gap-2">
              <Badge tone="neutral" label={ev.venueId ? 'Venue' : 'Standalone'} />
              <StatusPill status={ev.status} />
            </div>
          </div>

          {!editing && (
            <Card title="Details">
              <dl className="grid grid-cols-1 gap-y-4 sm:grid-cols-2">
                <div>
                  <dt className="text-xs font-medium uppercase tracking-wide text-[#475569]">Venue</dt>
                  <dd className="mt-1 text-sm text-slate-700">{venueLabel}</dd>
                </div>
                <div>
                  <dt className="text-xs font-medium uppercase tracking-wide text-[#475569]">
                    When ({effectiveTz})
                  </dt>
                  <dd className="mt-1 text-sm text-slate-700">
                    {fmt(ev.startsAt, effectiveTz)} → {fmt(ev.endsAt, effectiveTz)}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs font-medium uppercase tracking-wide text-[#475569]">
                    Description
                  </dt>
                  <dd className="mt-1 text-sm text-slate-700">
                    {ev.description ?? <span className="text-slate-400">—</span>}
                  </dd>
                </div>
                <div className="sm:col-span-2">
                  <dt className="text-xs font-medium uppercase tracking-wide text-[#475569]">
                    Ticket tiers
                  </dt>
                  <dd className="mt-1 flex flex-col gap-1 text-sm text-slate-700">
                    {ev.tiers.length === 0 && <span className="text-slate-400">—</span>}
                    {ev.tiers.map((t) => (
                      <div key={t.id} className="flex justify-between gap-4">
                        <span>
                          {t.name}
                          {t.capacity != null && (
                            <span className="text-slate-400"> · cap {t.capacity}</span>
                          )}
                        </span>
                        <span>
                          {t.pricePaise === 0 ? (
                            <span className="text-emerald-600">Free</span>
                          ) : (
                            `₹${(t.pricePaise / 100).toFixed(2)}`
                          )}
                        </span>
                      </div>
                    ))}
                  </dd>
                </div>
              </dl>

              <div className="mt-6 flex flex-wrap items-center gap-2 border-t border-[#f1f5f9] pt-4">
                {ev.status === 'draft' && (
                  <>
                    <Button variant="secondary" size="sm" disabled={!authed} onClick={startEdit}>
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      loading={publish.isPending}
                      disabled={!authed}
                      onClick={handlePublish}
                    >
                      Submit for review
                    </Button>
                    <Button
                      variant="danger"
                      size="sm"
                      loading={cancel.isPending}
                      disabled={!authed}
                      onClick={handleCancel}
                    >
                      Cancel
                    </Button>
                  </>
                )}
                {(ev.status === 'pending_review' || ev.status === 'published') && (
                  <>
                    <Button
                      variant="danger"
                      size="sm"
                      loading={cancel.isPending}
                      disabled={!authed}
                      onClick={handleCancel}
                    >
                      Cancel event
                    </Button>
                    <span className="text-xs text-slate-400">
                      {ev.status === 'pending_review'
                        ? 'Awaiting Circls review. You can still cancel.'
                        : 'This event is live. Cancelling takes it down for consumers.'}
                    </span>
                  </>
                )}
                {(ev.status === 'cancelled' || ev.status === 'rejected') && (
                  <span className="text-xs text-slate-400">
                    This event is {ev.status === 'cancelled' ? 'cancelled' : 'rejected'} and is
                    read-only.
                  </span>
                )}
              </div>
            </Card>
          )}

          {editing && ev.status === 'draft' && (
            <Card
              title="Edit event"
              subtitle="Only drafts can be edited. Submit for review when you're ready."
            >
              <form onSubmit={onSubmitEdit} className="flex max-w-2xl flex-col gap-4">
                <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} required />
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
                    <Input
                      label="Address line 1"
                      value={line1}
                      onChange={(e) => setLine1(e.target.value)}
                      placeholder="Street / building"
                    />
                    <Input
                      label="Address line 2"
                      value={line2}
                      onChange={(e) => setLine2(e.target.value)}
                      placeholder="Optional"
                    />
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                      <Input label="City" value={city} onChange={(e) => setCity(e.target.value)} />
                      <Input
                        label="State"
                        value={stateRegion}
                        onChange={(e) => setStateRegion(e.target.value)}
                      />
                      <Input label="PIN" value={pincode} onChange={(e) => setPincode(e.target.value)} />
                    </div>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                      <Input
                        label="Latitude"
                        type="number"
                        step="0.000001"
                        value={latRaw}
                        onChange={(e) => setLatRaw(e.target.value)}
                        hint="Optional — for the map pin."
                      />
                      <Input
                        label="Longitude"
                        type="number"
                        step="0.000001"
                        value={lngRaw}
                        onChange={(e) => setLngRaw(e.target.value)}
                      />
                      <Input
                        label="Timezone"
                        value={tzForm}
                        onChange={(e) => setTzForm(e.target.value)}
                        hint="IANA tz, e.g. Asia/Kolkata"
                      />
                    </div>
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

                <TiersEditor value={tiers} onChange={setTiers} />

                <div className="flex justify-end gap-2 pt-2">
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => {
                      setEditing(false);
                      setErrorMsg(null);
                    }}
                  >
                    Cancel
                  </Button>
                  <Button type="submit" loading={update.isPending} disabled={!authed}>
                    Save changes
                  </Button>
                </div>
              </form>
            </Card>
          )}

          <EventImages eventId={eventId} />

          <Card title={`Registrations${bookings ? ` (${bookings.rows.length})` : ''}`}>
            {ev.tiers.length > 0 && (
              <div className="mb-4 flex flex-col gap-1 rounded-[var(--radius)] border border-[#e5e7eb] bg-slate-50 p-3 text-sm">
                <div className="text-xs font-medium uppercase tracking-wide text-[#475569]">
                  Sold by tier
                </div>
                {ev.tiers.map((t) => (
                  <div key={t.id} className="flex justify-between text-slate-700">
                    <span>{t.name}</span>
                    <span>
                      {t.sold} sold{t.capacity != null ? ` / ${t.capacity}` : ''}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {bookingsLoading && <p className="py-6 text-center text-sm text-slate-400">Loading…</p>}
            {!bookingsLoading && bookings && bookings.rows.length === 0 && (
              <p className="py-6 text-center text-sm text-slate-400">No registrations yet.</p>
            )}
            {!bookingsLoading && bookings && bookings.rows.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-[#e5e7eb] text-left">
                      <th className="pb-2 pr-4 font-medium text-slate-500">Customer</th>
                      <th className="pb-2 pr-4 font-medium text-slate-500">Contact</th>
                      <th className="pb-2 pr-4 font-medium text-slate-500">Status</th>
                      <th className="pb-2 pr-4 font-medium text-slate-500">Amount</th>
                      <th className="pb-2 font-medium text-slate-500">Registered</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#f1f5f9]">
                    {bookings.rows.map((b) => (
                      <tr key={b.id}>
                        <td className="py-2.5 pr-4 font-medium text-slate-700">{b.customerName}</td>
                        <td className="py-2.5 pr-4 text-slate-700">{b.customerContact}</td>
                        <td className="py-2.5 pr-4">
                          <StatusPill status={b.status} />
                        </td>
                        <td className="py-2.5 pr-4 text-slate-700">
                          {b.totalPaise === 0 ? (
                            <span className="text-emerald-600">Free</span>
                          ) : (
                            `₹${(b.totalPaise / 100).toFixed(2)}`
                          )}
                        </td>
                        <td className="py-2.5 text-slate-700">{fmt(b.createdAt, effectiveTz)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

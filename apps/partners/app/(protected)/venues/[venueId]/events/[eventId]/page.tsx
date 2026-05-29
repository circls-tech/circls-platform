'use client';

import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { useAuth } from '@/lib/firebase/auth_context';
import {
  useCancelEvent,
  useEvent,
  usePublishEvent,
  useUpdateEvent,
} from '@/lib/api/events';
import { Button, Card, Input, StatusPill } from '@/lib/ui';

const IST_FMT = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

function fmt(iso: string) {
  return IST_FMT.format(new Date(iso));
}

const tz = 'Asia/Kolkata';

/**
 * Convert a `<input type="datetime-local">` value (interpreted as Asia/Kolkata
 * by venue convention) into a UTC ISO string. Mirrors the helper in the
 * new-event page so edits round-trip through the same tz convention.
 */
function localToVenueTzIso(local: string, tzName: string): string {
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

/** Convert a UTC ISO string into a `datetime-local` value in Asia/Kolkata. */
function isoToVenueTzLocal(iso: string, tzName: string): string {
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

export default function EventDetailPage() {
  const { venueId, eventId } = useParams<{ venueId: string; eventId: string }>();
  const tenantId = useSearchParams().get('tenantId') ?? '';
  const { user } = useAuth();
  const authed = Boolean(user);

  const { data: ev, isLoading } = useEvent(tenantId, eventId);
  const publish = usePublishEvent(tenantId, venueId);
  const cancel = useCancelEvent(tenantId, venueId);
  const update = useUpdateEvent(tenantId, venueId);

  const [editing, setEditing] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Edit form state.
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [startsAtLocal, setStartsAtLocal] = useState('');
  const [endsAtLocal, setEndsAtLocal] = useState('');
  const [priceRupees, setPriceRupees] = useState('0');
  const [capacityRaw, setCapacityRaw] = useState('');

  function startEdit() {
    if (!ev) return;
    setName(ev.name);
    setDescription(ev.description ?? '');
    setStartsAtLocal(isoToVenueTzLocal(ev.startsAt, tz));
    setEndsAtLocal(isoToVenueTzLocal(ev.endsAt, tz));
    setPriceRupees((ev.pricePaise / 100).toString());
    setCapacityRaw(ev.capacity != null ? String(ev.capacity) : '');
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

  async function onSubmitEdit(e: FormEvent) {
    e.preventDefault();
    setErrorMsg(null);
    if (!startsAtLocal || !endsAtLocal) {
      setErrorMsg('Set a start and end time.');
      return;
    }
    try {
      await update.mutateAsync({
        eventId,
        input: {
          name,
          description,
          startsAt: localToVenueTzIso(startsAtLocal, tz),
          endsAt: localToVenueTzIso(endsAtLocal, tz),
          pricePaise: Math.round(parseFloat(priceRupees || '0') * 100),
          ...(capacityRaw ? { capacity: parseInt(capacityRaw, 10) } : {}),
        },
      });
      setEditing(false);
    } catch (e) {
      setErrorMsg((e as Error).message);
    }
  }

  const backHref = `/venues/${venueId}/events${tenantId ? `?tenantId=${tenantId}` : ''}`;

  return (
    <div className="flex flex-col gap-6">
      <Link
        href={backHref}
        className="text-sm text-slate-500 hover:text-slate-800 transition-colors"
      >
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
            <StatusPill status={ev.status} />
          </div>

          {!editing && (
            <Card title="Details">
              <dl className="grid grid-cols-1 gap-y-4 sm:grid-cols-2">
                <div>
                  <dt className="text-xs font-medium uppercase tracking-wide text-[#475569]">
                    Description
                  </dt>
                  <dd className="mt-1 text-sm text-slate-700">
                    {ev.description ?? <span className="text-slate-400">—</span>}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs font-medium uppercase tracking-wide text-[#475569]">
                    When (IST)
                  </dt>
                  <dd className="mt-1 text-sm text-slate-700">
                    {fmt(ev.startsAt)} → {fmt(ev.endsAt)}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs font-medium uppercase tracking-wide text-[#475569]">
                    Price
                  </dt>
                  <dd className="mt-1 text-sm text-slate-700">
                    {ev.pricePaise === 0 ? (
                      <span className="text-emerald-600">Free</span>
                    ) : (
                      `₹${(ev.pricePaise / 100).toFixed(2)}`
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs font-medium uppercase tracking-wide text-[#475569]">
                    Capacity
                  </dt>
                  <dd className="mt-1 text-sm text-slate-700">
                    {ev.capacity ?? <span className="text-slate-400">Unlimited</span>}
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
                <Input
                  label="Name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
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

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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
        </>
      )}
    </div>
  );
}

'use client';

import { useMemo, useState } from 'react';
import {
  useAdminChangeRequestDetail,
  useAdminChangeRequests,
  useAdminListings,
  useAdminListingDetail,
  useApproveChangeRequest,
  useApproveListing,
  useRejectChangeRequest,
  useRejectListing,
} from '@/lib/api/queries';
import { ApiError } from '@/lib/api/client';
import type {
  AdminChangeRequestDetail,
  AdminChangeRequestRow,
  AdminListingDetail,
  AdminListingRow,
  AdminListingType,
} from '@/lib/api/types';

const IST_DATETIME = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

const IST_DATE = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: 'short',
  day: '2-digit',
});

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return IST_DATE.format(new Date(iso));
}

function fmtDatetime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return IST_DATETIME.format(new Date(iso));
}

function fmtRupees(paise: number | null | undefined): string {
  if (paise == null) return '—';
  if (paise === 0) return 'Free';
  return `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

function fmtAddress(addressJson: Record<string, unknown> | null | undefined): string {
  if (!addressJson) return '—';
  const parts = ['line1', 'line2', 'city', 'state', 'pincode']
    .map((k) => addressJson[k])
    .filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : '—';
}

/** The queue tabs: the four listing types + live-event change requests. */
type Tab = AdminListingType | 'changes';

const TYPES: { id: Tab; label: string; lower: string }[] = [
  { id: 'venue', label: 'Venues', lower: 'venues' },
  { id: 'arena', label: 'Arenas', lower: 'arenas' },
  { id: 'event', label: 'Events', lower: 'events' },
  { id: 'membership', label: 'Memberships', lower: 'memberships' },
  { id: 'changes', label: 'Changes', lower: 'change requests' },
];

/** Friendly labels for a change request's patch keys, deduped. */
const CHANGE_FIELD_LABELS: Record<string, string> = {
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

function changeFieldChips(fields: string[]): string[] {
  return [...new Set(fields.map((f) => CHANGE_FIELD_LABELS[f] ?? f))];
}

// ── Detail field helpers ───────────────────────────────────────────────────────

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">{label}</dt>
      <dd className="mt-0.5 text-sm text-slate-800">{value || '—'}</dd>
    </div>
  );
}

function DetailContent({ detail }: { detail: AdminListingDetail }) {
  const commonFields = (
    <>
      <Field label="ID" value={<span className="font-mono text-xs">{detail.id}</span>} />
      <Field label="Org / Tenant" value={detail.tenantName} />
      <Field label="Status" value={<span className="capitalize">{detail.status.replace(/_/g, ' ')}</span>} />
      <Field label="Submitted" value={fmtDate(detail.createdAt)} />
    </>
  );

  if (detail.type === 'venue') {
    return (
      <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {commonFields}
        <Field label="Address" value={fmtAddress(detail.addressJson)} />
        {(detail.lat != null && detail.lng != null) && (
          <Field label="Coordinates" value={`${detail.lat.toFixed(5)}, ${detail.lng.toFixed(5)}`} />
        )}
        <Field label="Timezone" value={detail.tzName} />
        <Field
          label="Tags"
          value={detail.tags && detail.tags.length > 0 ? detail.tags.join(', ') : 'None'}
        />
      </dl>
    );
  }

  if (detail.type === 'arena') {
    return (
      <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {commonFields}
        <Field label="Venue" value={detail.venueName} />
        <Field label="Sport" value={detail.sport} />
        <Field label="Capacity" value={detail.capacity != null ? String(detail.capacity) : null} />
        <Field
          label="Slot duration"
          value={detail.slotDurationMin != null ? `${detail.slotDurationMin} min` : null}
        />
        <Field
          label="Tags"
          value={detail.tags && detail.tags.length > 0 ? detail.tags.join(', ') : 'None'}
        />
      </dl>
    );
  }

  if (detail.type === 'event') {
    return (
      <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {commonFields}
        {(detail.seriesCount ?? 1) > 1 && (
          <Field
            label="Recurring"
            value={`${detail.seriesCount} dates — approving or rejecting applies to the whole series`}
          />
        )}
        {detail.venueId && <Field label="Venue" value={detail.venueName} />}
        <Field label="Starts" value={fmtDatetime(detail.startsAt)} />
        <Field label="Ends" value={fmtDatetime(detail.endsAt)} />
        <Field label="Price" value={fmtRupees(detail.pricePaise)} />
        <Field label="Capacity" value={detail.capacity != null ? String(detail.capacity) : 'Unlimited'} />
        {!detail.venueId && <Field label="Address" value={fmtAddress(detail.addressJson)} />}
        {detail.tzName && <Field label="Timezone" value={detail.tzName} />}
        {detail.description && (
          <div className="sm:col-span-2">
            <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">Description</dt>
            <dd className="mt-0.5 whitespace-pre-wrap text-sm text-slate-800">{detail.description}</dd>
          </div>
        )}
      </dl>
    );
  }

  if (detail.type === 'membership') {
    const benefitEntries = detail.benefits ? Object.entries(detail.benefits) : [];
    return (
      <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {commonFields}
        <Field
          label="Scope"
          value={detail.venueId ? `Venue: ${detail.venueName ?? detail.venueId}` : 'Tenant-wide'}
        />
        <Field label="Price" value={fmtRupees(detail.pricePaise)} />
        <Field
          label="Duration"
          value={detail.durationDays != null ? `${detail.durationDays} days` : null}
        />
        {detail.description && (
          <div className="sm:col-span-2">
            <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">Description</dt>
            <dd className="mt-0.5 whitespace-pre-wrap text-sm text-slate-800">{detail.description}</dd>
          </div>
        )}
        {benefitEntries.length > 0 && (
          <div className="sm:col-span-2">
            <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">Benefits</dt>
            <dd className="mt-1">
              <ul className="space-y-1 text-sm text-slate-800">
                {benefitEntries.map(([k, v]) => (
                  <li key={k}>
                    <span className="font-medium capitalize">{k.replace(/_/g, ' ')}:</span>{' '}
                    {String(v)}
                  </li>
                ))}
              </ul>
            </dd>
          </div>
        )}
      </dl>
    );
  }

  return null;
}

// ── Detail panel ───────────────────────────────────────────────────────────────

interface DetailPanelProps {
  row: AdminListingRow;
  onClose: () => void;
  onApprove: (row: AdminListingRow) => void;
  onReject: (row: AdminListingRow) => void;
  busy: boolean;
}

function DetailPanel({ row, onClose, onApprove, onReject, busy }: DetailPanelProps) {
  const { data, isLoading, isError, error } = useAdminListingDetail(row.type, row.id);

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/30"
        onClick={onClose}
        aria-hidden="true"
      />
      {/* Panel */}
      <div className="relative flex w-full max-w-lg flex-col bg-white shadow-xl">
        {/* Header */}
        <div className="flex items-start justify-between border-b border-slate-200 px-5 py-4">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
              {row.type}
            </p>
            <h2 className="mt-0.5 text-lg font-semibold text-slate-900">{row.name}</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="ml-4 rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
            aria-label="Close"
          >
            <svg className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
              <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {isLoading && (
            <p className="text-sm text-slate-400">Loading details…</p>
          )}
          {isError && (
            <p className="text-sm text-red-600">
              Failed to load: {error instanceof Error ? error.message : 'unknown error'}
            </p>
          )}
          {data && <DetailContent detail={data} />}
        </div>

        {/* Actions */}
        <div className="flex items-center justify-end gap-2 border-t border-slate-200 px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onReject(row)}
            disabled={busy}
            className="rounded-md border border-rose-200 bg-rose-50 px-4 py-2 text-sm font-medium text-rose-700 hover:bg-rose-100 disabled:opacity-50"
          >
            Reject
          </button>
          <button
            type="button"
            onClick={() => onApprove(row)}
            disabled={busy}
            className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            Approve
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Change requests (live-event edits awaiting approval) ──────────────────────

function ChangeCompareRow({
  label,
  current,
  proposed,
}: {
  label: string;
  current: React.ReactNode;
  proposed: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <div>
        <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">{label} — current</dt>
        <dd className="mt-0.5 text-sm text-slate-500">{current || '—'}</dd>
      </div>
      <div>
        <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">Proposed</dt>
        <dd className="mt-0.5 text-sm font-medium text-slate-900">{proposed || '—'}</dd>
      </div>
    </div>
  );
}

function ChangeDetailContent({ detail }: { detail: AdminChangeRequestDetail }) {
  const { patch, snapshot, event } = detail;

  // The event may have changed between request and review — flag it.
  const stale =
    (snapshot.name !== undefined && snapshot.name !== event.name) ||
    (snapshot.startsAt !== undefined && snapshot.startsAt !== event.startsAt) ||
    (snapshot.endsAt !== undefined && snapshot.endsAt !== event.endsAt) ||
    (snapshot.venueId !== undefined && snapshot.venueId !== event.venueId) ||
    (snapshot.tiers !== undefined &&
      JSON.stringify(snapshot.tiers.map((t) => ({ id: t.id, name: t.name, pricePaise: t.pricePaise, capacity: t.capacity ?? null }))) !==
        JSON.stringify(event.tiers.map((t) => ({ id: t.id, name: t.name, pricePaise: t.pricePaise, capacity: t.capacity }))));

  const locationChanged =
    patch.venueId !== undefined || patch.addressJson !== undefined || patch.tzName !== undefined;

  // Tier diff keyed by live tier id: proposed rows without an id are additions,
  // current tiers absent from the proposal are removals.
  const proposedById = new Map((patch.tiers ?? []).filter((t) => t.id).map((t) => [t.id!, t]));

  return (
    <dl className="flex flex-col gap-4">
      <Field label="Org / Tenant" value={detail.tenantName} />
      <Field label="Event" value={event.name} />
      <Field label="Submitted" value={fmtDate(detail.createdAt)} />
      {stale && (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          The event has changed since this request was submitted — review the current values below
          carefully.
        </p>
      )}

      {patch.name !== undefined && (
        <ChangeCompareRow label="Name" current={event.name} proposed={patch.name} />
      )}
      {(patch.startsAt !== undefined || patch.endsAt !== undefined) && (
        <ChangeCompareRow
          label="When"
          current={`${fmtDatetime(event.startsAt)} → ${fmtDatetime(event.endsAt)}`}
          proposed={`${fmtDatetime(patch.startsAt ?? event.startsAt)} → ${fmtDatetime(patch.endsAt ?? event.endsAt)}`}
        />
      )}
      {locationChanged && (
        <ChangeCompareRow
          label="Location"
          current={
            event.venueId
              ? `Venue: ${event.venueName ?? event.venueId}`
              : `${fmtAddress(event.addressJson)}${event.tzName ? ` (${event.tzName})` : ''}`
          }
          proposed={
            patch.venueId
              ? `Venue: ${detail.proposedVenueName ?? patch.venueId}`
              : `${fmtAddress(patch.addressJson)}${patch.tzName ? ` (${patch.tzName})` : ''}`
          }
        />
      )}

      {patch.tiers !== undefined && (
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">Ticket tiers</dt>
          <dd className="mt-1 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-slate-400">
                <tr>
                  <th className="py-1 pr-3 font-medium">Tier</th>
                  <th className="py-1 pr-3 font-medium">Price</th>
                  <th className="py-1 pr-3 font-medium">Capacity</th>
                  <th className="py-1 font-medium">Change</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {/* Current tiers: kept (possibly edited) or removed. */}
                {event.tiers.map((t) => {
                  const p = proposedById.get(t.id);
                  if (!p) {
                    return (
                      <tr key={t.id} className="text-rose-700">
                        <td className="py-1.5 pr-3 line-through">{t.name}</td>
                        <td className="py-1.5 pr-3 line-through">{fmtRupees(t.pricePaise)}</td>
                        <td className="py-1.5 pr-3 line-through">{t.capacity ?? '∞'}</td>
                        <td className="py-1.5">Removed {t.sold > 0 ? `— blocked, ${t.sold} sold` : ''}</td>
                      </tr>
                    );
                  }
                  const edited =
                    p.name !== t.name ||
                    p.pricePaise !== t.pricePaise ||
                    (p.capacity ?? null) !== t.capacity;
                  return (
                    <tr key={t.id}>
                      <td className="py-1.5 pr-3">
                        {p.name !== t.name ? (
                          <>
                            <span className="text-slate-400 line-through">{t.name}</span>{' '}
                            <span className="font-medium">{p.name}</span>
                          </>
                        ) : (
                          t.name
                        )}
                      </td>
                      <td className="py-1.5 pr-3">
                        {p.pricePaise !== t.pricePaise ? (
                          <>
                            <span className="text-slate-400 line-through">{fmtRupees(t.pricePaise)}</span>{' '}
                            <span className="font-medium">{fmtRupees(p.pricePaise)}</span>
                          </>
                        ) : (
                          fmtRupees(t.pricePaise)
                        )}
                      </td>
                      <td className="py-1.5 pr-3">
                        {(p.capacity ?? null) !== t.capacity ? (
                          <>
                            <span className="text-slate-400 line-through">{t.capacity ?? '∞'}</span>{' '}
                            <span className="font-medium">{p.capacity ?? '∞'}</span>
                          </>
                        ) : (
                          t.capacity ?? '∞'
                        )}
                        <span className="ml-1 text-xs text-slate-400">({t.sold} sold)</span>
                      </td>
                      <td className="py-1.5 text-slate-500">{edited ? 'Edited' : 'Unchanged'}</td>
                    </tr>
                  );
                })}
                {/* Additions: proposed rows without a live id. */}
                {(patch.tiers ?? [])
                  .filter((t) => !t.id)
                  .map((t, i) => (
                    <tr key={`new-${i}`} className="text-emerald-700">
                      <td className="py-1.5 pr-3 font-medium">{t.name}</td>
                      <td className="py-1.5 pr-3">{fmtRupees(t.pricePaise)}</td>
                      <td className="py-1.5 pr-3">{t.capacity ?? '∞'}</td>
                      <td className="py-1.5">Added</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </dd>
        </div>
      )}
    </dl>
  );
}

function ChangeDetailPanel({
  row,
  onClose,
  onApprove,
  onReject,
  busy,
}: {
  row: AdminChangeRequestRow;
  onClose: () => void;
  onApprove: (row: AdminChangeRequestRow) => void;
  onReject: (row: AdminChangeRequestRow) => void;
  busy: boolean;
}) {
  const { data, isLoading, isError, error } = useAdminChangeRequestDetail(row.id);

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="fixed inset-0 bg-black/30" onClick={onClose} aria-hidden="true" />
      <div className="relative flex w-full max-w-lg flex-col bg-white shadow-xl">
        <div className="flex items-start justify-between border-b border-slate-200 px-5 py-4">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
              change request
            </p>
            <h2 className="mt-0.5 text-lg font-semibold text-slate-900">{row.eventName}</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="ml-4 rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
            aria-label="Close"
          >
            <svg className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
              <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {isLoading && <p className="text-sm text-slate-400">Loading details…</p>}
          {isError && (
            <p className="text-sm text-red-600">
              Failed to load: {error instanceof Error ? error.message : 'unknown error'}
            </p>
          )}
          {data && <ChangeDetailContent detail={data} />}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-slate-200 px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onReject(row)}
            disabled={busy}
            className="rounded-md border border-rose-200 bg-rose-50 px-4 py-2 text-sm font-medium text-rose-700 hover:bg-rose-100 disabled:opacity-50"
          >
            Reject
          </button>
          <button
            type="button"
            onClick={() => onApprove(row)}
            disabled={busy}
            className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            Approve &amp; apply
          </button>
        </div>
      </div>
    </div>
  );
}

function ChangesSection() {
  const { data, isLoading, isError, error } = useAdminChangeRequests();
  const approve = useApproveChangeRequest();
  const reject = useRejectChangeRequest();
  const [actionError, setActionError] = useState<string | null>(null);
  const [selectedRow, setSelectedRow] = useState<AdminChangeRequestRow | null>(null);

  const rows = data?.rows ?? [];
  const busy = approve.isPending || reject.isPending;

  function handleActionError(err: unknown) {
    if (err instanceof ApiError) {
      if (err.code === 'change_request_not_pending') {
        setActionError('This change request is no longer pending review.');
        return;
      }
      // tier_has_bookings / tier_capacity_below_sold / event_not_published /
      // change_request_stale carry actionable messages — show them verbatim.
      setActionError(err.message);
      return;
    }
    setActionError(err instanceof Error ? err.message : 'unknown error');
  }

  function onApprove(row: AdminChangeRequestRow) {
    setActionError(null);
    approve.mutate(
      { id: row.id },
      { onError: handleActionError, onSuccess: () => setSelectedRow(null) },
    );
  }

  function onReject(row: AdminChangeRequestRow) {
    const reason = window.prompt(`Reason for rejecting the changes to "${row.eventName}" (optional):`);
    if (reason == null) return; // cancelled
    const trimmed = reason.trim();
    setActionError(null);
    reject.mutate(
      { id: row.id, reason: trimmed === '' ? undefined : trimmed },
      { onError: handleActionError, onSuccess: () => setSelectedRow(null) },
    );
  }

  return (
    <>
      {actionError && (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {actionError}
        </div>
      )}

      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-2 font-medium">Org</th>
              <th className="px-4 py-2 font-medium">Event</th>
              <th className="px-4 py-2 font-medium">Changes</th>
              <th className="px-4 py-2 font-medium">Submitted</th>
              <th className="px-4 py-2 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {isLoading && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-sm text-slate-400">
                  Loading…
                </td>
              </tr>
            )}
            {isError && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-sm text-red-600">
                  Failed to load: {error instanceof Error ? error.message : 'unknown error'}
                </td>
              </tr>
            )}
            {!isLoading && !isError && rows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-sm text-slate-400">
                  No change requests awaiting review.
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.id} className="transition-colors hover:bg-slate-50">
                <td className="px-4 py-2.5 text-slate-700">{r.tenantName}</td>
                <td className="px-4 py-2.5 font-medium text-slate-900">
                  {r.eventName}
                  <span className="ml-2 text-xs font-normal text-slate-400">
                    {fmtDatetime(r.eventStartsAt)}
                  </span>
                </td>
                <td className="px-4 py-2.5">
                  <div className="flex flex-wrap gap-1">
                    {changeFieldChips(r.fields).map((f) => (
                      <span
                        key={f}
                        className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600"
                      >
                        {f}
                      </span>
                    ))}
                  </div>
                </td>
                <td className="px-4 py-2.5 text-xs text-slate-500">{fmtDate(r.createdAt)}</td>
                <td className="px-4 py-2.5 text-right">
                  <div className="inline-flex gap-2">
                    <button
                      type="button"
                      onClick={() => setSelectedRow(r)}
                      className="rounded-md border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
                    >
                      View
                    </button>
                    <button
                      type="button"
                      onClick={() => onApprove(r)}
                      disabled={busy}
                      className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"
                    >
                      {approve.isPending ? 'Working…' : 'Approve'}
                    </button>
                    <button
                      type="button"
                      onClick={() => onReject(r)}
                      disabled={busy}
                      className="rounded-md border border-rose-200 bg-rose-50 px-3 py-1 text-xs font-medium text-rose-700 hover:bg-rose-100 disabled:opacity-50"
                    >
                      {reject.isPending ? 'Working…' : 'Reject'}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {selectedRow && (
        <ChangeDetailPanel
          row={selectedRow}
          onClose={() => setSelectedRow(null)}
          onApprove={onApprove}
          onReject={onReject}
          busy={busy}
        />
      )}
    </>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────────

export default function ListingsPage() {
  const [type, setType] = useState<Tab>('venue');

  const { data, isLoading, isError, error } = useAdminListings(
    type === 'changes' ? null : type,
    'pending_review',
  );

  const approve = useApproveListing();
  const reject = useRejectListing();
  const [actionError, setActionError] = useState<string | null>(null);
  const [selectedRow, setSelectedRow] = useState<AdminListingRow | null>(null);

  const rows: AdminListingRow[] = useMemo(() => data?.rows ?? [], [data]);

  const busy = approve.isPending || reject.isPending;
  const activeType = TYPES.find((t) => t.id === type)!;

  function handleActionError(err: unknown) {
    if (err instanceof ApiError) {
      if (err.status === 409 || err.code === 'listing_not_pending') {
        setActionError('This listing is no longer pending review.');
        return;
      }
      setActionError(err.message);
      return;
    }
    setActionError(err instanceof Error ? err.message : 'unknown error');
  }

  function onApprove(row: AdminListingRow) {
    setActionError(null);
    approve.mutate(
      { type: row.type, id: row.id },
      {
        onError: handleActionError,
        onSuccess: () => setSelectedRow(null),
      },
    );
  }

  function onReject(row: AdminListingRow) {
    const reason = window.prompt(
      `Reason for rejecting "${row.name}" (optional):`,
    );
    if (reason == null) return; // cancelled
    const trimmed = reason.trim();
    setActionError(null);
    reject.mutate(
      { type: row.type, id: row.id, reason: trimmed === '' ? undefined : trimmed },
      {
        onError: handleActionError,
        onSuccess: () => setSelectedRow(null),
      },
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Review queue</h1>
          <p className="text-sm text-slate-500">
            Listings awaiting Circls review before they go live.
          </p>
        </div>
        <div className="inline-flex rounded-md border border-slate-200 bg-white p-0.5 shadow-sm">
          {TYPES.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setType(t.id)}
              className={[
                'rounded px-3 py-1.5 text-sm font-medium transition-colors',
                type === t.id
                  ? 'bg-slate-900 text-white'
                  : 'text-slate-600 hover:text-slate-900',
              ].join(' ')}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {type === 'changes' && <ChangesSection />}

      {type !== 'changes' && actionError && (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {actionError}
        </div>
      )}

      {type !== 'changes' && (
      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-2 font-medium">Venue / Org</th>
              <th className="px-4 py-2 font-medium">Name</th>
              <th className="px-4 py-2 font-medium">Submitted</th>
              <th className="px-4 py-2 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {isLoading && (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-sm text-slate-400">
                  Loading…
                </td>
              </tr>
            )}
            {isError && (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-sm text-red-600">
                  Failed to load: {error instanceof Error ? error.message : 'unknown error'}
                </td>
              </tr>
            )}
            {!isLoading && !isError && rows.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-sm text-slate-400">
                  No {activeType.lower} awaiting review.
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={`${r.type}:${r.id}`} className="transition-colors hover:bg-slate-50">
                <td className="px-4 py-2.5 text-slate-700">{r.tenantName}</td>
                <td className="px-4 py-2.5 font-medium text-slate-900">
                  {r.name}
                  {(r.seriesCount ?? 1) > 1 && (
                    <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
                      recurring · {r.seriesCount} dates
                    </span>
                  )}
                </td>
                <td className="px-4 py-2.5 text-xs text-slate-500">{fmtDate(r.createdAt)}</td>
                <td className="px-4 py-2.5 text-right">
                  <div className="inline-flex gap-2">
                    <button
                      type="button"
                      onClick={() => setSelectedRow(r)}
                      className="rounded-md border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
                    >
                      View
                    </button>
                    <button
                      type="button"
                      onClick={() => onApprove(r)}
                      disabled={busy}
                      className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"
                    >
                      {approve.isPending ? 'Working…' : 'Approve'}
                    </button>
                    <button
                      type="button"
                      onClick={() => onReject(r)}
                      disabled={busy}
                      className="rounded-md border border-rose-200 bg-rose-50 px-3 py-1 text-xs font-medium text-rose-700 hover:bg-rose-100 disabled:opacity-50"
                    >
                      {reject.isPending ? 'Working…' : 'Reject'}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      )}

      {type !== 'changes' && selectedRow && (
        <DetailPanel
          row={selectedRow}
          onClose={() => setSelectedRow(null)}
          onApprove={onApprove}
          onReject={onReject}
          busy={busy}
        />
      )}
    </div>
  );
}

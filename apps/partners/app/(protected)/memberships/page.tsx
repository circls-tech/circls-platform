'use client';

import { type FormEvent, useMemo, useState } from 'react';
import { useAuth } from '@/lib/firebase/auth_context';
import { useOrg } from '@/lib/org_context';
import { useTimezone } from '@/lib/timezone_context';
import {
  useActivateMembership,
  useAddMember,
  useUpdateMember,
  useCreateMembership,
  useDeactivateMembership,
  useMembershipPurchases,
  useMemberships,
  useUpdateMembership,
  useUploadMembershipCover,
} from '@/lib/api/memberships';
import { useVenues } from '@/lib/api/queries';
import { type CurrencyCode, formatMoney, useVenueCurrencies } from '@/lib/currency';
import { Button, Card, Input, Modal, StatusPill } from '@/lib/ui';
import { MembershipArtwork } from '@/components/MembershipArtwork';
import { PendingPhotosPicker, type PendingPhoto } from '@/components/PendingPhotos';
import {
  MembershipTiersEditor,
  emptyMembershipTier,
  membershipTierDraftFromApi,
  membershipTiersToPayload,
  type MembershipTierDraft,
} from '@/components/MembershipTiersEditor';
import { QrTicketConfigEditor } from '@/components/QrTicketConfigEditor';
import type { Membership, MembershipPurchase, QrTicketConfig } from '@/lib/api/types';
import type { MembershipTierInput } from '@/lib/api/memberships';

function fmtDate(formatter: Intl.DateTimeFormat, iso: string) {
  return formatter.format(new Date(iso));
}

function fmtPrice(pricePaise: number, currency: CurrencyCode) {
  return pricePaise === 0 ? 'Free' : formatMoney(pricePaise, currency, { decimals: 2 });
}

export default function MembershipsPage() {
  const { activeTenantId, tenants } = useOrg();
  const activeTenant = tenants.find((t) => t.id === activeTenantId) ?? null;
  const tenantId = activeTenantId ?? '';
  const { user } = useAuth();
  const authed = Boolean(user);

  const { data: memberships, isLoading } = useMemberships(tenantId);
  const { data: venues } = useVenues(tenantId);
  // Venue-scoped plans price in their venue's currency; org-wide plans in the
  // tenant's currency.
  const { currencyFor } = useVenueCurrencies();
  const createMembership = useCreateMembership(tenantId);
  const uploadCover = useUploadMembershipCover(tenantId);
  const updateMembership = useUpdateMembership(tenantId);
  const activate = useActivateMembership(tenantId);
  const deactivate = useDeactivateMembership(tenantId);

  // Create form.
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [venueId, setVenueId] = useState(''); // '' = org-wide
  const [terms, setTerms] = useState('');
  const [tiers, setTiers] = useState<MembershipTierDraft[]>([emptyMembershipTier()]);
  const [qrConfig, setQrConfig] = useState<QrTicketConfig | null>(null);
  const [artwork, setArtwork] = useState<PendingPhoto[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [created, setCreated] = useState(false);

  // Row-level edit/toggle state.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [viewingBuyersId, setViewingBuyersId] = useState<string | null>(null);
  const viewingBuyers = memberships?.find((m) => m.id === viewingBuyersId) ?? null;
  const [rowErr, setRowErr] = useState<string | null>(null);

  function venueName(id: string | null) {
    if (!id) return 'Org-wide';
    return venues?.find((v) => v.id === id)?.name ?? 'Venue';
  }

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    setCreated(false);
    try {
      const plan = await createMembership.mutateAsync({
        name,
        ...(description ? { description } : {}),
        ...(venueId ? { venueId } : {}),
        ...(terms.trim() ? { terms: terms.trim() } : {}),
        tiers: membershipTiersToPayload(tiers),
        qrTicketConfig: qrConfig,
      });
      if (artwork[0]) {
        try {
          await uploadCover.mutateAsync({ membershipId: plan.id, file: artwork[0].file });
        } catch (uploadErr) {
          // The plan exists — surface the artwork failure without undoing it.
          setErr(
            `Plan created, but the artwork failed to upload (${(uploadErr as Error).message}) — add it from the Edit panel.`,
          );
        }
      }
      setName('');
      setDescription('');
      setVenueId('');
      setTerms('');
      setTiers([emptyMembershipTier()]);
      setQrConfig(null);
      setArtwork([]);
      setCreated(true);
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  async function onToggle(m: Membership) {
    setRowErr(null);
    try {
      if (m.status === 'active') {
        await deactivate.mutateAsync(m.id);
      } else if (m.status === 'inactive') {
        await activate.mutateAsync(m.id);
      }
    } catch (e) {
      setRowErr((e as Error).message);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="font-[family-name:var(--font-display)] text-2xl font-extrabold tracking-tight text-[#17151D]">Memberships</h1>
        {activeTenant && (
          <p className="mt-0.5 text-sm font-semibold text-[#EE5C2B]">{activeTenant.name}</p>
        )}
      </div>

      <Card title="Plans" subtitle="Time-bound passes your customers can buy.">
        {isLoading && <p className="py-2 text-sm text-slate-400">Loading…</p>}
        {!isLoading && memberships?.length === 0 && (
          <p className="py-2 text-sm text-slate-500">
            No memberships yet. Create one below.
          </p>
        )}
        {rowErr && (
          <p className="mb-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
            {rowErr}
          </p>
        )}
        {!isLoading && memberships && memberships.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#e5e7eb] text-left">
                  <th className="pb-2 pr-4 font-medium text-slate-500">Name</th>
                  <th className="pb-2 pr-4 font-medium text-slate-500">Scope</th>
                  <th className="pb-2 pr-4 font-medium text-slate-500">Tiers</th>
                  <th className="pb-2 pr-4 font-medium text-slate-500">Status</th>
                  <th className="pb-2 font-medium text-slate-500">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#f1f5f9]">
                {memberships.map((m) => {
                  const editable = m.status === 'pending_review' || m.status === 'inactive';
                  return (
                    <tr key={m.id} className="align-top">
                      <td className="py-2.5 pr-4 font-medium text-slate-700">
                        {m.name}
                        {m.description && (
                          <p className="mt-0.5 text-xs font-normal text-slate-400">
                            {m.description}
                          </p>
                        )}
                      </td>
                      <td className="py-2.5 pr-4 text-slate-700">
                        {m.venueId ? (
                          venueName(m.venueId)
                        ) : (
                          <span className="text-slate-500">Org-wide</span>
                        )}
                      </td>
                      <td className="py-2.5 pr-4 text-slate-700">
                        <ul className="flex flex-col gap-1">
                          {m.tiers.map((t) => (
                            <li key={t.id} className="flex flex-wrap items-baseline gap-x-1.5">
                              <span className="font-medium text-slate-700">{t.name}</span>
                              <span className="text-slate-500">
                                {t.pricePaise === 0 ? (
                                  <span className="text-emerald-600">Free</span>
                                ) : (
                                  fmtPrice(t.pricePaise, currencyFor(m.venueId))
                                )}{' '}
                                · {t.durationDays}d
                                {t.capacity != null && (
                                  <span className="text-slate-400"> · {t.remaining ?? 0}/{t.capacity} left</span>
                                )}
                              </span>
                            </li>
                          ))}
                          {m.tiers.length === 0 && <li className="text-slate-400">—</li>}
                        </ul>
                      </td>
                      <td className="py-2.5 pr-4">
                        <StatusPill status={m.status} />
                      </td>
                      <td className="py-2.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <Button
                            variant="secondary"
                            size="sm"
                            disabled={!authed || !editable}
                            onClick={() => {
                              setRowErr(null);
                              setEditingId(editingId === m.id ? null : m.id);
                            }}
                            title={
                              editable
                                ? undefined
                                : 'Only pending-review or inactive plans can be edited.'
                            }
                          >
                            {editingId === m.id ? 'Close' : 'Edit'}
                          </Button>
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => {
                              setRowErr(null);
                              setViewingBuyersId(m.id);
                            }}
                          >
                            View buyers
                          </Button>
                          {m.status === 'active' && (
                            <Button
                              variant="secondary"
                              size="sm"
                              loading={deactivate.isPending}
                              disabled={!authed}
                              onClick={() => onToggle(m)}
                            >
                              Deactivate
                            </Button>
                          )}
                          {m.status === 'inactive' && (
                            <Button
                              size="sm"
                              loading={activate.isPending}
                              disabled={!authed}
                              onClick={() => onToggle(m)}
                            >
                              Activate
                            </Button>
                          )}
                        </div>
                        {editingId === m.id && editable && (
                          <EditMembershipForm
                            membership={m}
                            tenantId={tenantId}
                            venues={venues ?? []}
                            currencyFor={currencyFor}
                            pending={updateMembership.isPending}
                            onCancel={() => setEditingId(null)}
                            onSave={async (input) => {
                              setRowErr(null);
                              try {
                                await updateMembership.mutateAsync({ id: m.id, input });
                                setEditingId(null);
                              } catch (e) {
                                setRowErr((e as Error).message);
                              }
                            }}
                          />
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Create a plan">
        <form onSubmit={onCreate} className="flex max-w-2xl flex-col gap-2.5">
          <Input
            label="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            placeholder="Monthly Unlimited"
          />
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-medium uppercase tracking-wide text-[#475569]">
              Description
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className="w-full rounded-[var(--radius)] border border-[#e5e7eb] bg-white px-3 py-1.5 text-sm text-[#0f172a] placeholder:text-[#94a3b8] hover:border-slate-300"
              placeholder="Optional summary shown above the tiers."
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-medium uppercase tracking-wide text-[#475569]">
              Venue scope
            </label>
            <select
              value={venueId}
              onChange={(e) => setVenueId(e.target.value)}
              className="w-full rounded-[var(--radius)] border border-[#e5e7eb] bg-white px-3 py-1.5 text-sm text-[#0f172a] hover:border-slate-300"
            >
              <option value="">All venues (org-wide)</option>
              {venues?.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
            <p className="text-xs text-[#94a3b8]">
              Org-wide plans apply across every venue; otherwise scope it to one venue.
            </p>
          </div>
          <MembershipTiersEditor value={tiers} onChange={setTiers} currency={currencyFor(venueId || null)} />
          <QrTicketConfigEditor
            value={qrConfig}
            onChange={setQrConfig}
            itemNoun="membership"
            enabledHint="Default for every tier — buyers get a scannable QR pass your staff validate on the Check-in page. Each tier above can override these rules or turn passes off."
          />
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-medium uppercase tracking-wide text-[#475569]">
              Terms &amp; conditions
            </label>
            <textarea
              value={terms}
              onChange={(e) => setTerms(e.target.value)}
              rows={2}
              maxLength={5000}
              className="w-full rounded-[var(--radius)] border border-[#e5e7eb] bg-white px-3 py-1.5 text-sm text-[#0f172a] placeholder:text-[#94a3b8] hover:border-slate-300"
              placeholder="Optional plan terms (refunds, validity, transferability…)."
            />
          </div>
          <PendingPhotosPicker
            photos={artwork}
            onChange={setArtwork}
            max={1}
            title="Plan artwork"
            hint="Optional cover image — JPEG, PNG or WebP, up to 10 MB. Uploaded when the plan is created."
          />
          {created && (
            <p className="text-sm text-amber-700">
              Membership created. It’s now pending review by Circls before it goes live.
            </p>
          )}
          {err && <p className="text-sm text-red-600">{err}</p>}
          <div className="flex justify-end">
            <Button
              type="submit"
              size="sm"
              petal="#F9B4D4"
              loading={createMembership.isPending || uploadCover.isPending}
              disabled={!tenantId || !authed}
            >
              Add membership
            </Button>
          </div>
        </form>
      </Card>

      {/* Buyers open in a modal — the list used to render inside the row's
          Actions cell, which squeezed a six-column table into one column. */}
      <Modal
        open={viewingBuyers !== null}
        onClose={() => setViewingBuyersId(null)}
        title={viewingBuyers ? `Buyers — ${viewingBuyers.name}` : 'Buyers'}
        maxWidth="max-w-3xl"
      >
        {viewingBuyers && (
          <MembershipBuyers
            tenantId={tenantId}
            membershipId={viewingBuyers.id}
            tiers={viewingBuyers.tiers}
          />
        )}
      </Modal>
    </div>
  );
}

interface EditMembershipFormProps {
  membership: Membership;
  tenantId: string;
  venues: { id: string; name: string }[];
  /** Resolves a venue id (or null for org-wide) to its display currency. */
  currencyFor: (venueId: string | null) => CurrencyCode;
  pending: boolean;
  onCancel: () => void;
  onSave: (input: {
    venueId: string | null;
    name: string;
    description: string;
    terms: string | null;
    tiers: MembershipTierInput[];
    qrTicketConfig: QrTicketConfig | null;
  }) => void | Promise<void>;
}

function EditMembershipForm({
  membership,
  tenantId,
  venues,
  currencyFor,
  pending,
  onCancel,
  onSave,
}: EditMembershipFormProps) {
  const [name, setName] = useState(membership.name);
  const [description, setDescription] = useState(membership.description ?? '');
  const [venueId, setVenueId] = useState(membership.venueId ?? '');
  const [terms, setTerms] = useState(membership.terms ?? '');
  const [tiers, setTiers] = useState<MembershipTierDraft[]>(() =>
    membership.tiers.length > 0
      ? membership.tiers.map(membershipTierDraftFromApi)
      : [emptyMembershipTier()],
  );
  const [qrConfig, setQrConfig] = useState<QrTicketConfig | null>(
    membership.qrTicketConfig ?? null,
  );

  function submit(e: FormEvent) {
    e.preventDefault();
    void onSave({
      venueId: venueId || null,
      name,
      description,
      terms: terms.trim() ? terms.trim() : null,
      tiers: membershipTiersToPayload(tiers),
      qrTicketConfig: qrConfig,
    });
  }

  return (
    <form
      onSubmit={submit}
      className="mt-3 flex max-w-2xl flex-col gap-3 rounded-[var(--radius)] border border-[#e5e7eb] bg-slate-50 p-4"
    >
      <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} required />
      <div className="flex flex-col gap-1">
        <label className="text-[11px] font-medium uppercase tracking-wide text-[#475569]">
          Description
        </label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          className="w-full rounded-[var(--radius)] border border-[#e5e7eb] bg-white px-3 py-1.5 text-sm text-[#0f172a] placeholder:text-[#94a3b8] hover:border-slate-300"
          placeholder="Optional"
        />
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-[11px] font-medium uppercase tracking-wide text-[#475569]">
          Venue scope
        </label>
        <select
          value={venueId}
          onChange={(e) => setVenueId(e.target.value)}
          className="w-full rounded-[var(--radius)] border border-[#e5e7eb] bg-white px-3 py-1.5 text-sm text-[#0f172a] hover:border-slate-300"
        >
          <option value="">All venues (org-wide)</option>
          {venues.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </select>
      </div>
      <MembershipTiersEditor value={tiers} onChange={setTiers} currency={currencyFor(venueId || null)} />
      <QrTicketConfigEditor
        value={qrConfig}
        onChange={setQrConfig}
        itemNoun="membership"
        enabledHint="Default for every tier — buyers get a scannable QR pass your staff validate on the Check-in page. Each tier above can override these rules or turn passes off."
      />
      <div className="flex flex-col gap-1">
        <label className="text-[11px] font-medium uppercase tracking-wide text-[#475569]">
          Terms &amp; conditions
        </label>
        <textarea
          value={terms}
          onChange={(e) => setTerms(e.target.value)}
          rows={2}
          maxLength={5000}
          className="w-full rounded-[var(--radius)] border border-[#e5e7eb] bg-white px-3 py-1.5 text-sm text-[#0f172a] placeholder:text-[#94a3b8] hover:border-slate-300"
          placeholder="Optional"
        />
      </div>
      <MembershipArtwork
        tenantId={tenantId}
        membershipId={membership.id}
        coverUrl={membership.coverUrl ?? null}
      />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" loading={pending}>
          Save
        </Button>
      </div>
    </form>
  );
}

interface MembershipBuyersProps {
  tenantId: string;
  membershipId: string;
  /** Live tiers of the plan — a hand-added member is placed on one. */
  tiers: Membership['tiers'];
}

function MembershipBuyers({ tenantId, membershipId, tiers }: MembershipBuyersProps) {
  const { data, isLoading, error } = useMembershipPurchases(tenantId, membershipId);
  const { resolveTz } = useTimezone();
  const dateFmt = useMemo(
    () =>
      new Intl.DateTimeFormat('en-IN', {
        timeZone: resolveTz(),
        day: '2-digit',
        month: 'short',
        year: 'numeric',
      }),
    [resolveTz],
  );

  const addMember = useAddMember(tenantId);
  const updateMember = useUpdateMember(tenantId);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: '', contact: '', tierId: '', startsAt: '', endsAt: '' });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editRange, setEditRange] = useState({ startsAt: '', endsAt: '' });
  const [err, setErr] = useState<string | null>(null);

  const rows = data?.rows ?? [];

  /** <input type="date"> wants YYYY-MM-DD; the API speaks ISO instants. */
  const toDateInput = (iso: string) => iso.slice(0, 10);
  /**
   * Swap the calendar date of `iso` while keeping its time of day. Rebuilding
   * the instant from the date alone would silently drop a membership that runs
   * from 09:30 back to midnight — so merely opening the editor and saving would
   * move someone's window by hours in both directions.
   */
  function withDate(iso: string, ymd: string): string {
    const [y, m, d] = ymd.split('-').map(Number);
    if (!y || !m || !d) return iso;
    const next = new Date(iso);
    if (Number.isNaN(next.getTime())) return iso;
    next.setUTCFullYear(y, m - 1, d);
    return next.toISOString();
  }

  async function submitNew(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    try {
      await addMember.mutateAsync({
        membershipId,
        input: {
          name: form.name.trim(),
          ...(form.contact.trim() ? { contact: form.contact.trim() } : {}),
          ...(form.tierId ? { membershipTierId: form.tierId } : {}),
          // A new member has no prior instant to preserve, so a bare date means
          // the start of that day.
          ...(form.startsAt ? { startsAt: `${form.startsAt}T00:00:00.000Z` } : {}),
          ...(form.endsAt ? { endsAt: `${form.endsAt}T00:00:00.000Z` } : {}),
        },
      });
      setForm({ name: '', contact: '', tierId: '', startsAt: '', endsAt: '' });
      setAdding(false);
    } catch (e2) {
      setErr((e2 as Error).message);
    }
  }

  async function saveRange(p: MembershipPurchase) {
    setErr(null);
    try {
      await updateMember.mutateAsync({
        userMembershipId: p.userMembershipId,
        membershipId,
        input: {
          startsAt: withDate(p.startsAt, editRange.startsAt),
          endsAt: withDate(p.endsAt, editRange.endsAt),
        },
      });
      setEditingId(null);
    } catch (e2) {
      setErr((e2 as Error).message);
    }
  }

  async function cancelMember(p: MembershipPurchase) {
    setErr(null);
    try {
      await updateMember.mutateAsync({
        userMembershipId: p.userMembershipId,
        membershipId,
        input: { status: 'cancelled' },
      });
    } catch (e2) {
      setErr((e2 as Error).message);
    }
  }

  if (isLoading) return <p className="py-6 text-center text-sm text-slate-400">Loading…</p>;
  if (error) {
    return (
      <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
        {(error as Error).message}
      </p>
    );
  }

  /** Edit / cancel controls for one member, shared by both layouts. */
  function rowActions(p2: MembershipPurchase) {
    if (editingId === p2.userMembershipId) {
      return (
        <span className="flex flex-wrap items-center gap-1">
          <Button
            size="sm"
            loading={updateMember.isPending}
            onClick={() => void saveRange(p2)}
            disabled={!editRange.startsAt || !editRange.endsAt}
          >
            Save
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setEditingId(null)}>
            Cancel
          </Button>
        </span>
      );
    }
    return (
      <span className="flex flex-wrap items-center gap-1">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            setEditingId(p2.userMembershipId);
            setEditRange({
              startsAt: toDateInput(p2.startsAt),
              endsAt: toDateInput(p2.endsAt),
            });
          }}
        >
          Edit dates
        </Button>
        {p2.status !== 'cancelled' && (
          <Button
            variant="danger"
            size="sm"
            loading={updateMember.isPending}
            onClick={() => void cancelMember(p2)}
          >
            Cancel
          </Button>
        )}
      </span>
    );
  }

  /** The validity cell: two date inputs while editing, plain text otherwise. */
  function validCell(p2: MembershipPurchase) {
    if (editingId !== p2.userMembershipId) {
      return `${fmtDate(dateFmt, p2.startsAt)} → ${fmtDate(dateFmt, p2.endsAt)}`;
    }
    return (
      <span className="flex flex-wrap items-center gap-1">
        <input
          type="date"
          value={editRange.startsAt}
          onChange={(e) => setEditRange((r) => ({ ...r, startsAt: e.target.value }))}
          aria-label="Valid from"
          className="rounded-md border border-slate-200 px-2 py-1 text-xs"
        />
        <span className="text-slate-400">→</span>
        <input
          type="date"
          value={editRange.endsAt}
          onChange={(e) => setEditRange((r) => ({ ...r, endsAt: e.target.value }))}
          aria-label="Valid to"
          className="rounded-md border border-slate-200 px-2 py-1 text-xs"
        />
      </span>
    );
  }

  const addBar = (
    <div className="flex flex-col gap-3">
      {err && (
        <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
          {err}
        </p>
      )}
      {adding ? (
        <form
          onSubmit={submitNew}
          className="flex flex-col gap-3 rounded-[var(--radius)] border border-[#e5e7eb] p-3"
        >
          <p className="text-xs text-slate-500">
            For someone who joined away from circls. They take a seat on the tier
            like any member, but no money is recorded — whatever they paid, they
            paid you directly.
          </p>
          <Input
            label="Name"
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            required
          />
          <Input
            label="Contact (optional)"
            value={form.contact}
            onChange={(e) => setForm((f) => ({ ...f, contact: e.target.value }))}
            placeholder="Phone or email"
          />
          {tiers.length > 0 && (
            <label className="flex flex-col gap-1">
              <span className="text-sm font-medium text-slate-700">Tier</span>
              <select
                value={form.tierId}
                onChange={(e) => setForm((f) => ({ ...f, tierId: e.target.value }))}
                className="rounded-md border border-slate-200 px-3 py-2 text-sm text-slate-700 focus:border-slate-400 focus:outline-none"
              >
                <option value="">Cheapest tier</option>
                {tiers.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="flex flex-wrap gap-3">
            <Input
              label="Starts (optional)"
              type="date"
              value={form.startsAt}
              onChange={(e) => setForm((f) => ({ ...f, startsAt: e.target.value }))}
            />
            <Input
              label="Ends (optional)"
              type="date"
              value={form.endsAt}
              onChange={(e) => setForm((f) => ({ ...f, endsAt: e.target.value }))}
              hint="Defaults to the tier's duration."
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button type="submit" size="sm" loading={addMember.isPending} disabled={!form.name.trim()}>
              Add member
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex justify-end">
          <Button petal="#BCE3A0" size="sm" onClick={() => setAdding(true)}>
            Add member
          </Button>
        </div>
      )}
    </div>
  );

  if (rows.length === 0) {
    return (
      <div className="flex flex-col gap-3">
        {addBar}
        <p className="py-6 text-center text-sm text-slate-400">No members yet.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {addBar}
      <p className="text-xs font-medium uppercase tracking-wide text-[#475569]">
        {rows.length} {rows.length === 1 ? 'member' : 'members'}
      </p>

      {/* The modal is centred in the viewport, so the list scrolls rather than
          pushing the panel off-screen on a short one. */}
      <div className="max-h-[60vh] overflow-y-auto">
        {/* Phones: one card per buyer — a six-column table is unreadable there. */}
        <ul className="flex flex-col gap-2 md:hidden">
          {rows.map((p) => (
            <li
              key={p.userMembershipId}
              className="rounded-[var(--radius)] border border-[#e5e7eb] p-3"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate font-medium text-slate-800">
                    {p.buyerName}
                    {p.external && (
                      <span className="ml-1.5 text-xs font-normal text-slate-400">· added by you</span>
                    )}
                  </p>
                  <p className="truncate text-xs text-slate-500">{p.buyerContact}</p>
                </div>
                <StatusPill status={p.status} />
              </div>
              <dl className="mt-2 flex flex-col gap-0.5 text-xs text-slate-600">
                <div className="flex justify-between gap-2">
                  <dt className="text-slate-400">Tier</dt>
                  <dd>{p.tierName ?? '—'}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-slate-400">Valid</dt>
                  <dd className="text-right">{validCell(p)}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-slate-400">Added</dt>
                  <dd>{fmtDate(dateFmt, p.createdAt)}</dd>
                </div>
              </dl>
              <div className="mt-2 flex justify-end">{rowActions(p)}</div>
            </li>
          ))}
        </ul>

        {/* Tablet and up: the full table. */}
        <div className="hidden overflow-x-auto md:block">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[#e5e7eb] text-left">
                <th className="pb-2 pr-4 font-medium text-slate-500">Buyer</th>
                <th className="pb-2 pr-4 font-medium text-slate-500">Contact</th>
                <th className="pb-2 pr-4 font-medium text-slate-500">Tier</th>
                <th className="pb-2 pr-4 font-medium text-slate-500">Status</th>
                <th className="pb-2 pr-4 font-medium text-slate-500">Valid</th>
                <th className="pb-2 pr-4 font-medium text-slate-500">Added</th>
                <th className="pb-2 font-medium text-slate-500" />
              </tr>
            </thead>
            <tbody className="divide-y divide-[#f1f5f9]">
              {rows.map((p) => (
                <tr key={p.userMembershipId}>
                  <td className="py-2.5 pr-4 font-medium text-slate-700">
                    {p.buyerName}
                    {p.external && (
                      <span className="ml-1.5 text-xs font-normal text-slate-400">· added by you</span>
                    )}
                  </td>
                  <td className="py-2.5 pr-4 text-slate-700">{p.buyerContact}</td>
                  <td className="py-2.5 pr-4 text-slate-700">{p.tierName ?? '—'}</td>
                  <td className="py-2.5 pr-4">
                    <StatusPill status={p.status} />
                  </td>
                  <td className="py-2.5 pr-4 whitespace-nowrap text-slate-700">
                    {validCell(p)}
                  </td>
                  <td className="py-2.5 pr-4 whitespace-nowrap text-slate-700">
                    {fmtDate(dateFmt, p.createdAt)}
                  </td>
                  <td className="py-2.5 text-right">{rowActions(p)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

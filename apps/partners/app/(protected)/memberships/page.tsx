'use client';

import { type FormEvent, useMemo, useState } from 'react';
import { useAuth } from '@/lib/firebase/auth_context';
import { useOrg } from '@/lib/org_context';
import { useTimezone } from '@/lib/timezone_context';
import {
  useActivateMembership,
  useCreateMembership,
  useDeactivateMembership,
  useMembershipPurchases,
  useMemberships,
  useUpdateMembership,
} from '@/lib/api/memberships';
import { useVenues } from '@/lib/api/queries';
import { Button, Card, Input, StatusPill } from '@/lib/ui';
import type { Membership } from '@/lib/api/types';

function fmtDate(formatter: Intl.DateTimeFormat, iso: string) {
  return formatter.format(new Date(iso));
}

export default function MembershipsPage() {
  const { activeTenantId } = useOrg();
  const tenantId = activeTenantId ?? '';
  const { user } = useAuth();
  const authed = Boolean(user);

  const { data: memberships, isLoading } = useMemberships(tenantId);
  const { data: venues } = useVenues(tenantId);
  const createMembership = useCreateMembership(tenantId);
  const updateMembership = useUpdateMembership(tenantId);
  const activate = useActivateMembership(tenantId);
  const deactivate = useDeactivateMembership(tenantId);

  // Create form.
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [priceRupees, setPriceRupees] = useState('0');
  const [durationDays, setDurationDays] = useState('30');
  const [venueId, setVenueId] = useState(''); // '' = org-wide
  const [err, setErr] = useState<string | null>(null);
  const [created, setCreated] = useState(false);

  // Row-level edit/toggle state.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [viewingBuyersId, setViewingBuyersId] = useState<string | null>(null);
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
      await createMembership.mutateAsync({
        name,
        ...(description ? { description } : {}),
        pricePaise: Math.round(parseFloat(priceRupees || '0') * 100),
        durationDays: parseInt(durationDays || '30', 10),
        ...(venueId ? { venueId } : {}),
      });
      setName('');
      setDescription('');
      setPriceRupees('0');
      setDurationDays('30');
      setVenueId('');
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
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-4">
        <h1 className="text-xl font-semibold text-[#0f172a]">Memberships</h1>
      </div>

      <Card title="Plans" subtitle="Time-bound passes your customers can buy.">
        {isLoading && <p className="py-6 text-center text-sm text-slate-400">Loading…</p>}
        {!isLoading && memberships?.length === 0 && (
          <p className="py-6 text-center text-sm text-slate-400">
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
                  <th className="pb-2 pr-4 font-medium text-slate-500">Price</th>
                  <th className="pb-2 pr-4 font-medium text-slate-500">Duration</th>
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
                        {m.pricePaise === 0 ? (
                          <span className="text-emerald-600">Free</span>
                        ) : (
                          `₹${(m.pricePaise / 100).toFixed(2)}`
                        )}
                      </td>
                      <td className="py-2.5 pr-4 text-slate-700">{m.durationDays}d</td>
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
                              setViewingBuyersId(viewingBuyersId === m.id ? null : m.id);
                            }}
                          >
                            {viewingBuyersId === m.id ? 'Hide buyers' : 'View buyers'}
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
                            venues={venues ?? []}
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
                        {viewingBuyersId === m.id && (
                          <MembershipBuyers tenantId={tenantId} membershipId={m.id} />
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
        <form onSubmit={onCreate} className="flex max-w-lg flex-col gap-3">
          <Input
            label="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            placeholder="Monthly Unlimited"
          />
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium uppercase tracking-wide text-[#475569]">
              Description
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className="w-full rounded-[var(--radius)] border border-[#e5e7eb] bg-white px-3 py-2 text-sm text-[#0f172a] placeholder:text-[#94a3b8] hover:border-slate-300"
              placeholder="Optional benefits, perks, etc."
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium uppercase tracking-wide text-[#475569]">
              Venue scope
            </label>
            <select
              value={venueId}
              onChange={(e) => setVenueId(e.target.value)}
              className="w-full rounded-[var(--radius)] border border-[#e5e7eb] bg-white px-3 py-2 text-sm text-[#0f172a] hover:border-slate-300"
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
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Input
              label="Price (₹)"
              type="number"
              min={0}
              step="0.01"
              value={priceRupees}
              onChange={(e) => setPriceRupees(e.target.value)}
              hint="0 = free."
            />
            <Input
              label="Duration (days)"
              type="number"
              min={1}
              value={durationDays}
              onChange={(e) => setDurationDays(e.target.value)}
              required
            />
          </div>
          {created && (
            <p className="text-sm text-amber-700">
              Membership created. It’s now pending review by Circls before it goes live.
            </p>
          )}
          {err && <p className="text-sm text-red-600">{err}</p>}
          <div className="flex justify-end">
            <Button type="submit" loading={createMembership.isPending} disabled={!tenantId || !authed}>
              Add membership
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}

interface EditMembershipFormProps {
  membership: Membership;
  venues: { id: string; name: string }[];
  pending: boolean;
  onCancel: () => void;
  onSave: (input: {
    venueId: string | null;
    name: string;
    description: string;
    pricePaise: number;
    durationDays: number;
  }) => void | Promise<void>;
}

function EditMembershipForm({
  membership,
  venues,
  pending,
  onCancel,
  onSave,
}: EditMembershipFormProps) {
  const [name, setName] = useState(membership.name);
  const [description, setDescription] = useState(membership.description ?? '');
  const [priceRupees, setPriceRupees] = useState((membership.pricePaise / 100).toString());
  const [durationDays, setDurationDays] = useState(String(membership.durationDays));
  const [venueId, setVenueId] = useState(membership.venueId ?? '');

  function submit(e: FormEvent) {
    e.preventDefault();
    void onSave({
      venueId: venueId || null,
      name,
      description,
      pricePaise: Math.round(parseFloat(priceRupees || '0') * 100),
      durationDays: parseInt(durationDays || '30', 10),
    });
  }

  return (
    <form
      onSubmit={submit}
      className="mt-3 flex max-w-lg flex-col gap-3 rounded-[var(--radius)] border border-[#e5e7eb] bg-slate-50 p-4"
    >
      <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} required />
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium uppercase tracking-wide text-[#475569]">
          Description
        </label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          className="w-full rounded-[var(--radius)] border border-[#e5e7eb] bg-white px-3 py-2 text-sm text-[#0f172a] placeholder:text-[#94a3b8] hover:border-slate-300"
          placeholder="Optional"
        />
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium uppercase tracking-wide text-[#475569]">
          Venue scope
        </label>
        <select
          value={venueId}
          onChange={(e) => setVenueId(e.target.value)}
          className="w-full rounded-[var(--radius)] border border-[#e5e7eb] bg-white px-3 py-2 text-sm text-[#0f172a] hover:border-slate-300"
        >
          <option value="">All venues (org-wide)</option>
          {venues.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </select>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Input
          label="Price (₹)"
          type="number"
          min={0}
          step="0.01"
          value={priceRupees}
          onChange={(e) => setPriceRupees(e.target.value)}
        />
        <Input
          label="Duration (days)"
          type="number"
          min={1}
          value={durationDays}
          onChange={(e) => setDurationDays(e.target.value)}
          required
        />
      </div>
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
}

function MembershipBuyers({ tenantId, membershipId }: MembershipBuyersProps) {
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

  return (
    <div className="mt-3 max-w-2xl rounded-[var(--radius)] border border-[#e5e7eb] bg-slate-50 p-4">
      <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-[#475569]">
        Buyers{data ? ` (${data.rows.length})` : ''}
      </h3>
      {isLoading && <p className="py-4 text-center text-sm text-slate-400">Loading…</p>}
      {error && (
        <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
          {(error as Error).message}
        </p>
      )}
      {!isLoading && !error && data && data.rows.length === 0 && (
        <p className="py-4 text-center text-sm text-slate-400">No purchases yet.</p>
      )}
      {!isLoading && !error && data && data.rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[#e5e7eb] text-left">
                <th className="pb-2 pr-4 font-medium text-slate-500">Buyer</th>
                <th className="pb-2 pr-4 font-medium text-slate-500">Contact</th>
                <th className="pb-2 pr-4 font-medium text-slate-500">Status</th>
                <th className="pb-2 pr-4 font-medium text-slate-500">Valid</th>
                <th className="pb-2 font-medium text-slate-500">Purchased</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#f1f5f9]">
              {data.rows.map((p) => (
                <tr key={p.userMembershipId}>
                  <td className="py-2.5 pr-4 font-medium text-slate-700">{p.buyerName}</td>
                  <td className="py-2.5 pr-4 text-slate-700">{p.buyerContact}</td>
                  <td className="py-2.5 pr-4">
                    <StatusPill status={p.status} />
                  </td>
                  <td className="py-2.5 pr-4 text-slate-700">
                    {fmtDate(dateFmt, p.startsAt)} → {fmtDate(dateFmt, p.endsAt)}
                  </td>
                  <td className="py-2.5 text-slate-700">{fmtDate(dateFmt, p.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

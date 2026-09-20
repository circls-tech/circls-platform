'use client';

import { type FormEvent, useMemo, useState } from 'react';
import { useTimezone } from '@/lib/timezone_context';
import {
  useAddMember,
  useMembershipPurchases,
  useRefundMember,
  useUpdateMember,
} from '@/lib/api/memberships';
import type {
  Membership,
  MembershipPurchase,
  MemberStatus,
  MemberStatusCounts,
} from '@/lib/api/types';
import { Button, Input, StatusPill } from '@/lib/ui';

function fmtDate(formatter: Intl.DateTimeFormat, iso: string) {
  return formatter.format(new Date(iso));
}

/**
 * Members are listed one state at a time. A plan that has run for a while
 * holds far more lapsed members than current ones, and mixed together they
 * buried the people the partner is actually serving — the same reason venues
 * moved their closed ones onto a tab of their own.
 */
const MEMBER_TABS: { key: MemberStatus; label: string }[] = [
  { key: 'active', label: 'Active' },
  { key: 'expired', label: 'Expired' },
  { key: 'cancelled', label: 'Cancelled' },
];

/** What an empty tab means, in the partner's words. */
const EMPTY_TAB: Record<MemberStatus, string> = {
  active: 'No active members. Expired and cancelled ones are on the other tabs.',
  expired: 'No expired members.',
  cancelled: 'No cancelled members.',
};

const NO_COUNTS: MemberStatusCounts = { active: 0, expired: 0, cancelled: 0 };

/**
 * Everyone holding a plan: those who bought it, and those the partner added by
 * hand. Supports adding a member, correcting their validity window, and
 * cancelling — the actions PR #183 introduced.
 *
 * Lives in its own file because it outgrew the memberships page: at ~350 lines
 * it was the largest of the four things that page was doing.
 */
export interface MembershipMembersProps {
  tenantId: string;
  membershipId: string;
  /** Live tiers of the plan — a hand-added member is placed on one. */
  tiers: Membership['tiers'];
  /** Whether the walk-in form is open. Omit to let this component own it; pass
   *  it when a Reception button elsewhere on the page opens the desk. */
  walkInOpen?: boolean;
  onWalkInOpenChange?: (open: boolean) => void;
}

export function MembershipMembers({
  tenantId,
  membershipId,
  tiers,
  walkInOpen,
  onWalkInOpenChange,
}: MembershipMembersProps) {
  const [tab, setTab] = useState<MemberStatus>('active');
  const { data, isLoading, isFetching, error } = useMembershipPurchases(
    tenantId,
    membershipId,
    tab,
  );
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
  const refundMember = useRefundMember(tenantId);
  // Controlled when a Reception button owns the state, uncontrolled otherwise.
  const [ownAdding, setOwnAdding] = useState(false);
  const adding = walkInOpen ?? ownAdding;
  const setAdding = (open: boolean) => {
    if (walkInOpen === undefined) setOwnAdding(open);
    onWalkInOpenChange?.(open);
  };
  const [form, setForm] = useState({ name: '', contact: '', tierId: '', startsAt: '', endsAt: '' });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editRange, setEditRange] = useState({ startsAt: '', endsAt: '' });
  const [err, setErr] = useState<string | null>(null);

  const rows = data?.rows ?? [];
  const counts = data?.counts ?? NO_COUNTS;
  const total = counts.active + counts.expired + counts.cancelled;
  // The listing is capped; the counts are not. The cap comes back with the
  // rows, so a truncated list is told apart from a merely short one exactly,
  // and never from a count that moved between the two queries. Skipped
  // mid-fetch, while the rows still belong to the tab being left.
  const listed = counts[tab];
  const truncated =
    !isFetching && data != null && rows.length >= data.limit && listed > rows.length;

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
      // A new member is always active. Staying on Expired or Cancelled would
      // close the form onto an unchanged list — no row, no confirmation — and
      // the obvious next move is to add the person again.
      setTab('active');
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

  /**
   * Hands the money back and ends the membership. Kept separate from cancel:
   * that one only frees the seat, which is why it doesn't say Refund.
   */
  async function refund(p: MembershipPurchase) {
    setErr(null);
    try {
      await refundMember.mutateAsync({
        userMembershipId: p.userMembershipId,
        membershipId,
        reason: 'Refunded by organiser',
      });
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
    // Same editor either way — an expired membership is renewed by moving its
    // end date into the future — but on a lapsed member that is what the
    // partner came to do, so the button says so.
    const expired = p2.status === 'expired';
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
          {...(expired ? { title: 'Move the end date into the future to renew them' } : {})}
        >
          {expired ? 'Renew' : 'Edit dates'}
        </Button>
        {/* Only where circls took money. A hand-added or free membership has
            nothing to give back, so offering Refund would be a lie. */}
        {p2.refundable && (
          <Button
            variant="danger"
            size="sm"
            loading={refundMember.isPending}
            onClick={() => void refund(p2)}
            title="Refund what they paid and end the membership"
          >
            Refund
          </Button>
        )}
        {p2.status !== 'cancelled' && (
          <Button
            variant="secondary"
            size="sm"
            loading={updateMember.isPending}
            onClick={() => void cancelMember(p2)}
            title="End the membership and free its seat. No money is returned."
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
        {p2.status === 'expired' && (
          <span className="block w-full whitespace-normal text-xs text-slate-500">
            An end date in the future makes them active again.
          </span>
        )}
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

  // Nobody in any state: the tabs would be three empty boxes. The rows are
  // checked as well so a plan is never declared empty over a list it just
  // returned.
  if (total === 0 && rows.length === 0) {
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

      <div className="flex flex-wrap gap-1" role="tablist" aria-label="Member status">
        {MEMBER_TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => {
              setTab(t.key);
              // The row being edited is about to leave the screen.
              setEditingId(null);
            }}
            className={[
              'rounded-[var(--radius)] border-2 px-3 py-1 text-sm font-bold transition-colors',
              tab === t.key
                ? 'border-[#17151D] bg-[#BCE3A0] text-[#17151D] shadow-[2px_2px_0_#17151D]'
                : 'border-transparent text-slate-500 hover:bg-white hover:text-[#17151D]',
            ].join(' ')}
          >
            {t.label} <span className="font-normal text-slate-500">({counts[t.key]})</span>
          </button>
        ))}
      </div>

      {tab === 'expired' && rows.length > 0 && (
        <p className="text-xs text-slate-500">
          An expired member still holds their seat on the tier. Renew one by moving
          its end date into the future.
        </p>
      )}

      {truncated && (
        <p className="text-xs text-slate-500">
          Showing the {rows.length} most recently added of {listed}.
        </p>
      )}

      {rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-slate-400">{EMPTY_TAB[tab]}</p>
      ) : (
      /* Long lists scroll inside the card rather than pushing everything below
         them off the page. */
      <div
        className={`max-h-[60vh] overflow-y-auto transition-opacity ${
          isFetching ? 'opacity-60' : ''
        }`}
        aria-busy={isFetching}
      >
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
      )}
    </div>
  );
}

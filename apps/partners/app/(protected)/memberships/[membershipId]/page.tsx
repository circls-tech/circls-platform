'use client';

import { type FormEvent, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useAuth } from '@/lib/firebase/auth_context';
import { useOrg } from '@/lib/org_context';
import {
  useActivateMembership,
  useDeactivateMembership,
  useMemberships,
  useUpdateMembership,
} from '@/lib/api/memberships';
import { useVenues } from '@/lib/api/queries';
import { type CurrencyCode, formatMoney, useVenueCurrencies } from '@/lib/currency';
import type { Membership } from '@/lib/api/types';
import { Button, Card, StatusPill } from '@/lib/ui';
import { MembershipArtwork } from '@/components/MembershipArtwork';
import { MembershipMembers } from '@/components/MembershipMembers';
import {
  MembershipPlanFields,
  planDraftFrom,
  planDraftToInput,
  type MembershipPlanDraft,
} from '@/components/MembershipPlanFields';

function fmtPrice(pricePaise: number, currency: CurrencyCode) {
  return pricePaise === 0 ? 'Free' : formatMoney(pricePaise, currency, { decimals: 2 });
}

/**
 * A single plan: what it is, its tiers, and everyone holding it.
 *
 * Editing lives here rather than in the list, where the form used to render
 * inside the row's Actions cell — the narrowest column on the page — and be
 * squeezed to a fraction of its width.
 */
export default function MembershipDetailPage() {
  const { membershipId } = useParams<{ membershipId: string }>();
  const { activeTenantId } = useOrg();
  const tenantId = activeTenantId ?? '';
  const { user } = useAuth();
  const authed = Boolean(user);

  // Derived from the tenant's plan list rather than its own endpoint: a tenant
  // has a handful of plans and the list is already cached by the sidebar route,
  // so a dedicated read would cost a round trip to save nothing.
  const { data: memberships, isLoading } = useMemberships(tenantId);
  const membership = memberships?.find((m) => m.id === membershipId) ?? null;

  const { data: venues } = useVenues(tenantId);
  const { currencyFor } = useVenueCurrencies();
  const updateMembership = useUpdateMembership(tenantId);
  const activate = useActivateMembership(tenantId);
  const deactivate = useDeactivateMembership(tenantId);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<MembershipPlanDraft | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Seed the editor once the plan has loaded, and re-seed if it changes under
  // us (a save, or an admin decision landing while the page is open).
  useEffect(() => {
    if (membership && !editing) setDraft(planDraftFrom(membership));
  }, [membership, editing]);

  if (isLoading) return <p className="text-sm text-slate-400">Loading plan…</p>;
  if (!membership) {
    return (
      <div className="flex flex-col gap-3">
        <Link href="/memberships" className="text-sm text-slate-500 hover:underline">
          ← Memberships
        </Link>
        <p className="text-sm text-slate-500">
          That plan isn&apos;t in this organisation. It may belong to another one — check the
          switcher in the top bar.
        </p>
      </div>
    );
  }

  // Circls reviews a plan before it goes live, so a live one can't be edited
  // freely; deactivate it first.
  const editable = membership.status === 'pending_review' || membership.status === 'inactive';
  const currency = currencyFor(membership.venueId);
  const venueLabel = membership.venueId
    ? (venues?.find((v) => v.id === membership.venueId)?.name ?? 'Venue')
    : 'Org-wide';

  async function onToggle(m: Membership) {
    setErr(null);
    try {
      if (m.status === 'active') await deactivate.mutateAsync(m.id);
      else if (m.status === 'inactive') await activate.mutateAsync(m.id);
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  async function onSave(e: FormEvent) {
    e.preventDefault();
    // Re-checked inside the handler: the early return above narrows the render
    // path, not a callback that could fire after a refetch emptied the list.
    if (!draft || !membership) return;
    setErr(null);
    try {
      await updateMembership.mutateAsync({
        id: membership.id,
        input: planDraftToInput(draft),
      });
      setEditing(false);
    } catch (e2) {
      setErr((e2 as Error).message);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <Link href="/memberships" className="text-sm text-slate-500 hover:underline">
          ← Memberships
        </Link>
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <h1 className="font-[family-name:var(--font-display)] text-2xl font-extrabold tracking-tight text-[#17151D]">
            {membership.name}
          </h1>
          <StatusPill status={membership.status} />
        </div>
        <p className="mt-0.5 text-sm text-slate-500">{venueLabel}</p>
      </div>

      {err && (
        <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
          {err}
        </p>
      )}

      <Card
        title={editing ? 'Edit plan' : 'Plan'}
        subtitle={
          editing
            ? undefined
            : editable
              ? undefined
              : 'Live plans are read-only. Deactivate the plan to edit it.'
        }
      >
        {editing && draft ? (
          <form onSubmit={onSave} className="flex max-w-2xl flex-col gap-2.5">
            <MembershipPlanFields
              value={draft}
              onChange={setDraft}
              venues={venues ?? []}
              currencyFor={currencyFor}
            />
            <MembershipArtwork
              tenantId={tenantId}
              membershipId={membership.id}
              coverUrl={membership.coverUrl ?? null}
            />
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => {
                  setEditing(false);
                  setDraft(planDraftFrom(membership));
                }}
              >
                Cancel
              </Button>
              <Button type="submit" size="sm" loading={updateMembership.isPending}>
                Save
              </Button>
            </div>
          </form>
        ) : (
          <div className="flex flex-col gap-4">
            {membership.description && (
              <p className="text-sm text-slate-600">{membership.description}</p>
            )}

            <div className="flex flex-col gap-1">
              <span className="text-[11px] font-medium uppercase tracking-wide text-[#475569]">
                Tiers
              </span>
              {membership.tiers.length === 0 ? (
                <p className="text-sm text-slate-400">No tiers.</p>
              ) : (
                <ul className="flex flex-col gap-1 text-sm">
                  {membership.tiers.map((t) => (
                    <li key={t.id} className="flex flex-wrap items-baseline gap-x-1.5">
                      <span className="font-medium text-slate-700">{t.name}</span>
                      <span className="text-slate-500">
                        {t.pricePaise === 0 ? (
                          <span className="text-emerald-600">Free</span>
                        ) : (
                          fmtPrice(t.pricePaise, currency)
                        )}{' '}
                        · {t.durationDays}d
                        {t.capacity != null && (
                          <span className="text-slate-400">
                            {' '}
                            · {t.remaining ?? 0}/{t.capacity} left
                          </span>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {membership.terms && (
              <div className="flex flex-col gap-1">
                <span className="text-[11px] font-medium uppercase tracking-wide text-[#475569]">
                  Terms &amp; conditions
                </span>
                <p className="whitespace-pre-wrap text-sm text-slate-600">{membership.terms}</p>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                disabled={!authed || !editable}
                onClick={() => setEditing(true)}
                title={editable ? undefined : 'Only pending-review or inactive plans can be edited.'}
              >
                Edit
              </Button>
              {membership.status === 'active' && (
                <Button
                  variant="secondary"
                  size="sm"
                  loading={deactivate.isPending}
                  disabled={!authed}
                  onClick={() => void onToggle(membership)}
                >
                  Deactivate
                </Button>
              )}
              {membership.status === 'inactive' && (
                <Button
                  size="sm"
                  loading={activate.isPending}
                  disabled={!authed}
                  onClick={() => void onToggle(membership)}
                >
                  Activate
                </Button>
              )}
            </div>
          </div>
        )}
      </Card>

      <Card title="Members" subtitle="Everyone holding this plan, however they joined.">
        <MembershipMembers
          tenantId={tenantId}
          membershipId={membership.id}
          tiers={membership.tiers}
        />
      </Card>
    </div>
  );
}

'use client';

import { useState } from 'react';
import { Button, Input } from '@/lib/ui';
import type { Membership, MembershipTier } from '@/lib/api/types';
import { useRegroupMembership } from '@/lib/api/memberships';
import {
  MAX_TIER_GROUPS,
  emptyTierGroup,
  moveItem,
  resolveTierGroups,
  tierGroupDraftsFrom,
  type TierGroupDraft,
} from '@/lib/tier_groups';

/**
 * Tier groups: the partner names a few groups ("Day Passes", "Punch Passes")
 * and puts each tier in one, so customers choose from a tab per group instead
 * of one long list. Groups are presentation only, which is why a live plan
 * can be regrouped (see {@link RegroupPanel}) while its prices stay locked.
 */

const LABEL = 'text-[11px] font-medium uppercase tracking-wide text-[#475569]';
const SELECT =
  'w-full rounded-[var(--radius)] border border-[#e5e7eb] bg-white px-3 py-1.5 text-sm text-[#0f172a] hover:border-slate-300';

/** Name, tagline and order of each group. */
export function TierGroupsFields({
  value,
  onChange,
  disabled,
}: {
  value: TierGroupDraft[];
  /** `removed` is the local id of a group just removed, so the caller can
   *  ungroup its tiers in the same update. */
  onChange: (next: TierGroupDraft[], removed?: string) => void;
  disabled?: boolean;
}) {
  function update(i: number, patch: Partial<TierGroupDraft>) {
    onChange(value.map((g, j) => (j === i ? { ...g, ...patch } : g)));
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5">
        <label className={LABEL}>Tier groups</label>
        <p className="text-xs text-[#94a3b8]">
          Optional. With many tiers, group them (e.g. Day passes, Punch passes, Memberships) and
          customers pick from a tab per group.
        </p>
      </div>
      {value.map((g, i) => (
        <div key={g.localId} className="grid grid-cols-1 gap-2 rounded-[var(--radius)] border border-[#e5e7eb] bg-slate-50 p-2.5 sm:grid-cols-12">
          <div className="sm:col-span-4">
            <Input
              label="Group name"
              placeholder="e.g. Punch passes"
              value={g.name}
              maxLength={40}
              disabled={disabled}
              onChange={(e) => update(i, { name: e.target.value })}
            />
          </div>
          <div className="sm:col-span-5">
            <Input
              label="Who it's for"
              placeholder="e.g. For occasional climbers who want flexibility."
              value={g.tagline}
              maxLength={140}
              disabled={disabled}
              onChange={(e) => update(i, { tagline: e.target.value })}
            />
          </div>
          {!disabled && (
            <div className="flex items-end gap-1 sm:col-span-3 sm:justify-end">
              <Button type="button" variant="ghost" size="sm" aria-label={`Move ${g.name || 'group'} up`} disabled={i === 0} onClick={() => onChange(moveItem(value, i, i - 1))}>
                ↑
              </Button>
              <Button type="button" variant="ghost" size="sm" aria-label={`Move ${g.name || 'group'} down`} disabled={i === value.length - 1} onClick={() => onChange(moveItem(value, i, i + 1))}>
                ↓
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-red-600 hover:bg-red-50"
                onClick={() => onChange(value.filter((_, j) => j !== i), g.localId)}
              >
                Remove
              </Button>
            </div>
          )}
        </div>
      ))}
      {!disabled && value.length < MAX_TIER_GROUPS && (
        <Button type="button" variant="secondary" size="sm" className="self-start" onClick={() => onChange([...value, emptyTierGroup()])}>
          + Add group
        </Button>
      )}
    </div>
  );
}

/** Which group a tier is in. Hidden until the plan has a named group. */
export function TierGroupSelect({
  groups,
  value,
  onChange,
  disabled,
}: {
  groups: readonly TierGroupDraft[];
  value: string | null;
  onChange: (localId: string | null) => void;
  disabled?: boolean;
}) {
  const named = groups.filter((g) => g.name.trim());
  if (named.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <label className={LABEL}>Group</label>
      <select className={SELECT} value={value ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">No group</option>
        {named.map((g) => (
          <option key={g.localId} value={g.localId}>
            {g.name.trim()}
          </option>
        ))}
      </select>
    </div>
  );
}

interface RegroupRow {
  id: string;
  name: string;
  groupLocalId: string | null;
}

/**
 * Regroup a plan's tiers, live or not: rename, reorder or add groups, move a
 * tier between groups, and change the tiers' order. Prices and durations stay
 * in the plan editor.
 */
export function RegroupPanel({
  tenantId,
  membership,
  describeTier,
}: {
  tenantId: string;
  membership: Membership;
  describeTier: (t: MembershipTier) => string;
}) {
  const regroup = useRegroupMembership(tenantId);
  // Absent from an API that predates tier groups.
  const savedGroups = membership.tierGroups ?? [];
  const [editing, setEditing] = useState(false);
  const [groups, setGroups] = useState<TierGroupDraft[]>([]);
  const [rows, setRows] = useState<RegroupRow[]>([]);
  const [err, setErr] = useState<string | null>(null);

  function start() {
    setGroups(tierGroupDraftsFrom(savedGroups));
    setRows(membership.tiers.map((t) => ({ id: t.id, name: t.name, groupLocalId: t.groupKey })));
    setErr(null);
    setEditing(true);
  }

  async function save() {
    setErr(null);
    const { groups: tierGroups, keyOf } = resolveTierGroups(groups);
    try {
      await regroup.mutateAsync({
        id: membership.id,
        tierGroups,
        tiers: rows.map((r) => ({ id: r.id, groupKey: keyOf(r.groupLocalId) })),
      });
      setEditing(false);
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  if (!editing) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-sm text-slate-500">
          {savedGroups.length > 0
            ? `${savedGroups.length} group${savedGroups.length === 1 ? '' : 's'}: ${savedGroups.map((g) => g.name).join(', ')}.`
            : 'No groups yet: customers see every tier in one list.'}
        </p>
        <Button type="button" variant="secondary" size="sm" disabled={membership.tiers.length === 0} onClick={start}>
          {savedGroups.length > 0 ? 'Edit groups' : 'Group tiers'}
        </Button>
      </div>
    );
  }

  const tiersById = new Map(membership.tiers.map((t) => [t.id, t]));
  return (
    <div className="flex max-w-2xl flex-col gap-3">
      <TierGroupsFields
        value={groups}
        onChange={(next, removed) => {
          setGroups(next);
          if (removed) setRows((rs) => rs.map((r) => (r.groupLocalId === removed ? { ...r, groupLocalId: null } : r)));
        }}
      />
      <div className="flex flex-col gap-1.5">
        <label className={LABEL}>Tiers, in the order customers see them</label>
        {rows.map((r, i) => (
          <div key={r.id} className="grid grid-cols-1 items-end gap-2 rounded-[var(--radius)] border border-[#e5e7eb] p-2.5 sm:grid-cols-12">
            <div className="sm:col-span-5">
              <p className="text-sm font-medium text-slate-700">{r.name}</p>
              <p className="text-xs text-slate-500">{describeTier(tiersById.get(r.id)!)}</p>
            </div>
            <div className="sm:col-span-5">
              <TierGroupSelect
                groups={groups}
                value={r.groupLocalId}
                onChange={(localId) => setRows((rs) => rs.map((x, j) => (j === i ? { ...x, groupLocalId: localId } : x)))}
              />
            </div>
            <div className="flex gap-1 sm:col-span-2 sm:justify-end">
              <Button type="button" variant="ghost" size="sm" aria-label={`Move ${r.name} up`} disabled={i === 0} onClick={() => setRows((rs) => moveItem(rs, i, i - 1))}>
                ↑
              </Button>
              <Button type="button" variant="ghost" size="sm" aria-label={`Move ${r.name} down`} disabled={i === rows.length - 1} onClick={() => setRows((rs) => moveItem(rs, i, i + 1))}>
                ↓
              </Button>
            </div>
          </div>
        ))}
      </div>
      {err && <p className="text-sm text-red-600">{err}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" size="sm" onClick={() => setEditing(false)}>
          Cancel
        </Button>
        <Button type="button" size="sm" loading={regroup.isPending} onClick={() => void save()}>
          Save groups
        </Button>
      </div>
    </div>
  );
}

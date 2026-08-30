'use client';

import type { CurrencyCode } from '@/lib/currency';
import type { Membership, QrTicketConfig } from '@/lib/api/types';
import type { MembershipTierInput } from '@/lib/api/memberships';
import { Input } from '@/lib/ui';
import {
  MembershipTiersEditor,
  emptyMembershipTier,
  membershipTierDraftFromApi,
  membershipTiersToPayload,
  type MembershipTierDraft,
} from '@/components/MembershipTiersEditor';
import { QrTicketConfigEditor } from '@/components/QrTicketConfigEditor';

/**
 * Everything a plan is, minus its artwork.
 *
 * Creating and editing a plan ask for exactly the same things, and used to do
 * so through two near-identical copies of this form — so a field added to one
 * quietly went missing from the other. Artwork is the one genuine difference
 * and stays with each caller: a new plan has no id to upload against yet, so it
 * queues a pending file, while an existing one manages its cover directly.
 */
export interface MembershipPlanDraft {
  name: string;
  description: string;
  /** '' means org-wide. */
  venueId: string;
  terms: string;
  tiers: MembershipTierDraft[];
  qrConfig: QrTicketConfig | null;
}

export function emptyPlanDraft(): MembershipPlanDraft {
  return {
    name: '',
    description: '',
    venueId: '',
    terms: '',
    tiers: [emptyMembershipTier()],
    qrConfig: null,
  };
}

export function planDraftFrom(m: Membership): MembershipPlanDraft {
  return {
    name: m.name,
    description: m.description ?? '',
    venueId: m.venueId ?? '',
    terms: m.terms ?? '',
    tiers:
      m.tiers.length > 0 ? m.tiers.map(membershipTierDraftFromApi) : [emptyMembershipTier()],
    qrConfig: m.qrTicketConfig ?? null,
  };
}

export interface MembershipPlanInput {
  venueId: string | null;
  name: string;
  description: string;
  terms: string | null;
  tiers: MembershipTierInput[];
  qrTicketConfig: QrTicketConfig | null;
}

export function planDraftToInput(d: MembershipPlanDraft): MembershipPlanInput {
  return {
    venueId: d.venueId || null,
    name: d.name,
    description: d.description,
    terms: d.terms.trim() ? d.terms.trim() : null,
    tiers: membershipTiersToPayload(d.tiers),
    qrTicketConfig: d.qrConfig,
  };
}

const TEXTAREA =
  'w-full rounded-[var(--radius)] border border-[#e5e7eb] bg-white px-3 py-1.5 text-sm text-[#0f172a] placeholder:text-[#94a3b8] hover:border-slate-300';
const LABEL = 'text-[11px] font-medium uppercase tracking-wide text-[#475569]';

export interface MembershipPlanFieldsProps {
  value: MembershipPlanDraft;
  onChange: (next: MembershipPlanDraft) => void;
  venues: { id: string; name: string }[];
  /** Resolves a venue id (or null for org-wide) to its display currency. */
  currencyFor: (venueId: string | null) => CurrencyCode;
}

export function MembershipPlanFields({
  value,
  onChange,
  venues,
  currencyFor,
}: MembershipPlanFieldsProps) {
  const set = <K extends keyof MembershipPlanDraft>(key: K, v: MembershipPlanDraft[K]) =>
    onChange({ ...value, [key]: v });

  return (
    <>
      <Input
        label="Name"
        value={value.name}
        onChange={(e) => set('name', e.target.value)}
        required
        placeholder="Monthly Unlimited"
      />

      <div className="flex flex-col gap-1">
        <label className={LABEL}>Description</label>
        <textarea
          value={value.description}
          onChange={(e) => set('description', e.target.value)}
          rows={2}
          className={TEXTAREA}
          placeholder="Optional summary shown above the tiers."
        />
      </div>

      <div className="flex flex-col gap-1">
        <label className={LABEL}>Venue scope</label>
        <select
          value={value.venueId}
          onChange={(e) => set('venueId', e.target.value)}
          className="w-full rounded-[var(--radius)] border border-[#e5e7eb] bg-white px-3 py-1.5 text-sm text-[#0f172a] hover:border-slate-300"
        >
          <option value="">All venues (org-wide)</option>
          {venues.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </select>
        <p className="text-xs text-[#94a3b8]">
          Org-wide plans apply across every venue; otherwise scope it to one venue.
        </p>
      </div>

      <MembershipTiersEditor
        value={value.tiers}
        onChange={(t) => set('tiers', t)}
        currency={currencyFor(value.venueId || null)}
      />

      <QrTicketConfigEditor
        value={value.qrConfig}
        onChange={(q) => set('qrConfig', q)}
        itemNoun="membership"
        enabledHint="Default for every tier — buyers get a scannable QR pass your staff validate on the Check-in page. Each tier above can override these rules or turn passes off."
      />

      <div className="flex flex-col gap-1">
        <label className={LABEL}>Terms &amp; conditions</label>
        <textarea
          value={value.terms}
          onChange={(e) => set('terms', e.target.value)}
          rows={2}
          maxLength={5000}
          className={TEXTAREA}
          placeholder="Optional plan terms (refunds, validity, transferability…)."
        />
      </div>
    </>
  );
}

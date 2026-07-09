'use client';

import { Button, Input } from '@/lib/ui';
import type { MembershipBenefitItem, MembershipTier, QrTicketConfig } from '@/lib/api/types';
import type { MembershipTierInput } from '@/lib/api/memberships';
import { type CurrencyCode, currencySymbol } from '@/lib/currency';
import { BenefitsEditor, cleanBenefits } from './BenefitsEditor';
import { DEFAULT_QR_CONFIG, QrTicketRulesFields } from './QrTicketConfigEditor';

/** Per-tier QR pass setting: follow the plan default, custom rules, or off. */
export type TierQrMode = 'inherit' | 'custom' | 'off';

/** Form-draft shape: price/number inputs stay strings and convert on submit. */
export interface MembershipTierDraft {
  name: string;
  description?: string;
  priceRupees: string; // form input in major units; converted to minor units on submit
  durationDays: string;
  capacity?: string; // blank = unlimited
  benefits: MembershipBenefitItem[];
  qrMode: TierQrMode;
  /** Custom rules; only sent when qrMode === 'custom'. */
  qrConfig: QrTicketConfig;
}

export function emptyMembershipTier(): MembershipTierDraft {
  return {
    name: '',
    description: '',
    priceRupees: '0',
    durationDays: '30',
    capacity: '',
    benefits: [],
    qrMode: 'inherit',
    qrConfig: DEFAULT_QR_CONFIG,
  };
}

/** Convert a draft's QR mode + rules to the API's tier `qrTicketConfig` field. */
function tierQrToPayload(t: MembershipTierDraft): QrTicketConfig | null {
  if (t.qrMode === 'inherit') return null;
  if (t.qrMode === 'off') return { ...DEFAULT_QR_CONFIG, enabled: false };
  return { ...t.qrConfig, enabled: true };
}

/** Convert drafts to the API payload shape. */
export function membershipTiersToPayload(tiers: MembershipTierDraft[]): MembershipTierInput[] {
  return tiers.map((t) => ({
    name: t.name.trim(),
    description: t.description?.trim() ? t.description.trim() : undefined,
    pricePaise: Math.round(parseFloat(t.priceRupees || '0') * 100),
    durationDays: parseInt(t.durationDays || '30', 10),
    benefits: { items: cleanBenefits(t.benefits) },
    capacity: t.capacity?.trim() ? parseInt(t.capacity, 10) : null,
    qrTicketConfig: tierQrToPayload(t),
  }));
}

/** Hydrate a draft from a membership tier (as returned by the API). */
export function membershipTierDraftFromApi(
  t: Pick<
    MembershipTier,
    'name' | 'description' | 'pricePaise' | 'durationDays' | 'capacity' | 'benefits' | 'qrTicketConfig'
  >,
): MembershipTierDraft {
  return {
    name: t.name,
    description: t.description ?? '',
    priceRupees: String(t.pricePaise / 100),
    durationDays: String(t.durationDays),
    capacity: t.capacity == null ? '' : String(t.capacity),
    benefits: t.benefits?.items ?? [],
    qrMode: t.qrTicketConfig == null ? 'inherit' : t.qrTicketConfig.enabled ? 'custom' : 'off',
    qrConfig: t.qrTicketConfig?.enabled ? t.qrTicketConfig : DEFAULT_QR_CONFIG,
  };
}

const QR_MODES: { mode: TierQrMode; label: string }[] = [
  { mode: 'inherit', label: 'Plan default' },
  { mode: 'custom', label: 'Custom' },
  { mode: 'off', label: 'Off' },
];

const QR_MODE_HINTS: Record<TierQrMode, string> = {
  inherit: 'Passes for this tier follow the plan-level QR settings below.',
  custom: 'This tier issues passes with its own rules, ignoring the plan-level settings.',
  off: 'No QR passes for this tier, even when the plan enables them.',
};

export function MembershipTiersEditor({
  value,
  onChange,
  currency,
  disabled,
}: {
  value: MembershipTierDraft[];
  onChange: (next: MembershipTierDraft[]) => void;
  currency: CurrencyCode;
  disabled?: boolean;
}) {
  function update(i: number, patch: Partial<MembershipTierDraft>) {
    onChange(value.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  }

  return (
    <div className="flex flex-col gap-3">
      <label className="text-xs font-medium uppercase tracking-wide text-[#475569]">
        Plan tiers
      </label>
      {value.map((t, i) => (
        <div
          key={i}
          className="flex flex-col gap-3 rounded-[var(--radius)] border border-[#e5e7eb] bg-slate-50 p-3"
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-12">
            <div className="sm:col-span-5">
              <Input
                label="Tier name"
                placeholder="e.g. Gold"
                value={t.name}
                disabled={disabled}
                onChange={(e) => update(i, { name: e.target.value })}
              />
            </div>
            <div className="sm:col-span-3">
              <Input
                label={`Price (${currencySymbol(currency)})`}
                type="number"
                min={0}
                step="0.01"
                inputMode="decimal"
                value={t.priceRupees}
                disabled={disabled}
                onChange={(e) => update(i, { priceRupees: e.target.value })}
              />
            </div>
            <div className="sm:col-span-2">
              <Input
                label="Days"
                type="number"
                min={1}
                inputMode="numeric"
                value={t.durationDays}
                disabled={disabled}
                onChange={(e) => update(i, { durationDays: e.target.value })}
              />
            </div>
            <div className="sm:col-span-2">
              <Input
                label="Capacity"
                type="number"
                min={1}
                inputMode="numeric"
                placeholder="∞"
                value={t.capacity ?? ''}
                disabled={disabled}
                onChange={(e) => update(i, { capacity: e.target.value })}
              />
            </div>
            <div className="sm:col-span-12">
              <Input
                label="Description"
                placeholder="Optional"
                value={t.description ?? ''}
                disabled={disabled}
                onChange={(e) => update(i, { description: e.target.value })}
              />
            </div>
          </div>
          {!disabled && (
            <BenefitsEditor items={t.benefits} onChange={(items) => update(i, { benefits: items })} />
          )}
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium uppercase tracking-wide text-[#475569]">
              QR passes for this tier
            </label>
            <div className="inline-flex w-fit rounded-md border border-slate-200 bg-white p-0.5">
              {QR_MODES.map(({ mode, label }) => (
                <button
                  key={mode}
                  type="button"
                  disabled={disabled}
                  onClick={() => update(i, { qrMode: mode })}
                  className={[
                    'rounded px-3 py-1.5 text-sm font-medium transition-colors',
                    t.qrMode === mode
                      ? 'bg-slate-900 text-white'
                      : 'text-slate-600 hover:text-slate-900',
                  ].join(' ')}
                >
                  {label}
                </button>
              ))}
            </div>
            <p className="text-xs text-[#94a3b8]">{QR_MODE_HINTS[t.qrMode]}</p>
          </div>
          {t.qrMode === 'custom' && (
            <QrTicketRulesFields
              cfg={t.qrConfig}
              onPatch={(p) => update(i, { qrConfig: { ...t.qrConfig, enabled: true, ...p } })}
              itemNoun="membership"
            />
          )}
          {!disabled && (
            <div className="flex justify-end">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-red-600 hover:bg-red-50"
                disabled={value.length <= 1}
                onClick={() => onChange(value.filter((_, j) => j !== i))}
              >
                Remove tier
              </Button>
            </div>
          )}
        </div>
      ))}
      {!disabled && (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="self-start"
          onClick={() => onChange([...value, emptyMembershipTier()])}
        >
          + Add tier
        </Button>
      )}
    </div>
  );
}

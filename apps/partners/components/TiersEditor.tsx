'use client';

import { Button, Input } from '@/lib/ui';
import type { EventTier, QrTicketConfig } from '@/lib/api/types';
import type { TierInput } from '@/lib/api/events';
import { type CurrencyCode, currencySymbol } from '@/lib/currency';
import {
  DEFAULT_QR_CONFIG,
  QrTicketRulesFields,
  TierQrModeControl,
  type TierQrMode,
} from './QrTicketConfigEditor';

/** Form-draft shape: the price input stays a string (major units — rupees or
 *  dollars per the venue currency) and converts to minor units on submit. */
export interface TierDraft {
  name: string;
  description?: string;
  priceRupees: string; // form input in major units; converted to minor units on submit
  capacity?: string; // blank = unlimited
  qrMode: TierQrMode;
  /** Custom rules; only sent when qrMode === 'custom'. */
  qrConfig: QrTicketConfig;
}

export function emptyTier(): TierDraft {
  return {
    name: '',
    description: '',
    priceRupees: '0',
    capacity: '',
    qrMode: 'inherit',
    qrConfig: DEFAULT_QR_CONFIG,
  };
}

/** Convert a draft's QR mode + rules to the API's tier `qrTicketConfig` field. */
function tierQrToPayload(t: TierDraft): QrTicketConfig | null {
  if (t.qrMode === 'inherit') return null;
  if (t.qrMode === 'off') return { ...DEFAULT_QR_CONFIG, enabled: false };
  return { ...t.qrConfig, enabled: true };
}

/** Convert drafts to the API payload shape. */
export function tiersToPayload(tiers: TierDraft[]): TierInput[] {
  return tiers.map((t) => ({
    name: t.name.trim(),
    description: t.description?.trim() ? t.description.trim() : undefined,
    pricePaise: Math.round(parseFloat(t.priceRupees || '0') * 100),
    capacity: t.capacity?.trim() ? parseInt(t.capacity, 10) : null,
    qrTicketConfig: tierQrToPayload(t),
  }));
}

/** Hydrate a draft from an event's tier (as returned by GET event). */
export function tierDraftFromApi(
  t: Pick<EventTier, 'name' | 'description' | 'pricePaise' | 'capacity' | 'qrTicketConfig'>,
): TierDraft {
  return {
    name: t.name,
    description: t.description ?? '',
    priceRupees: String(t.pricePaise / 100),
    capacity: t.capacity == null ? '' : String(t.capacity),
    qrMode: t.qrTicketConfig == null ? 'inherit' : t.qrTicketConfig.enabled ? 'custom' : 'off',
    qrConfig: t.qrTicketConfig?.enabled ? t.qrTicketConfig : DEFAULT_QR_CONFIG,
  };
}

export function TiersEditor({
  value,
  onChange,
  currency,
  disabled,
}: {
  value: TierDraft[];
  onChange: (next: TierDraft[]) => void;
  currency: CurrencyCode;
  disabled?: boolean;
}) {
  function update(i: number, patch: Partial<TierDraft>) {
    onChange(value.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  }

  return (
    <div className="flex flex-col gap-3">
      <label className="text-[11px] font-medium uppercase tracking-wide text-[#475569]">
        Ticket tiers
      </label>
      {value.map((t, i) => (
        <div
          key={i}
          className="grid grid-cols-1 gap-3 rounded-[var(--radius)] border border-[#e5e7eb] bg-slate-50 p-3 sm:grid-cols-12"
        >
          <div className="sm:col-span-5">
            <Input
              label="Tier name"
              placeholder="e.g. VIP"
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
          <div className="sm:col-span-4">
            <Input
              label="Capacity"
              type="number"
              min={1}
              inputMode="numeric"
              placeholder="Blank = unlimited"
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
          <div className="sm:col-span-12">
            <TierQrModeControl
              mode={t.qrMode}
              onChange={(mode) => update(i, { qrMode: mode })}
              disabled={disabled}
              parentNoun="event"
            />
          </div>
          {t.qrMode === 'custom' && (
            <div className="sm:col-span-12">
              <QrTicketRulesFields
                cfg={t.qrConfig}
                onPatch={(p) => update(i, { qrConfig: { ...t.qrConfig, enabled: true, ...p } })}
                itemNoun="event"
              />
            </div>
          )}
          {!disabled && (
            <div className="flex justify-end sm:col-span-12">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-red-600 hover:bg-red-50"
                disabled={value.length <= 1}
                onClick={() => onChange(value.filter((_, j) => j !== i))}
              >
                Remove
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
          onClick={() => onChange([...value, emptyTier()])}
        >
          + Add tier
        </Button>
      )}
    </div>
  );
}

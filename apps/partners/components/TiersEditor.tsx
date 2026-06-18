'use client';

import { Button, Input } from '@/lib/ui';
import type { EventTier } from '@/lib/api/types';
import type { TierInput } from '@/lib/api/events';

/** Form-draft shape: rupee input stays a string and converts to paise on submit. */
export interface TierDraft {
  name: string;
  description?: string;
  priceRupees: string; // form input; converted to paise on submit
  capacity?: string; // blank = unlimited
}

export function emptyTier(): TierDraft {
  return { name: '', description: '', priceRupees: '0', capacity: '' };
}

/** Convert drafts to the API payload shape. */
export function tiersToPayload(tiers: TierDraft[]): TierInput[] {
  return tiers.map((t) => ({
    name: t.name.trim(),
    description: t.description?.trim() ? t.description.trim() : undefined,
    pricePaise: Math.round(parseFloat(t.priceRupees || '0') * 100),
    capacity: t.capacity?.trim() ? parseInt(t.capacity, 10) : null,
  }));
}

/** Hydrate a draft from an event's tier (as returned by GET event). */
export function tierDraftFromApi(t: Pick<EventTier, 'name' | 'description' | 'pricePaise' | 'capacity'>): TierDraft {
  return {
    name: t.name,
    description: t.description ?? '',
    priceRupees: String(t.pricePaise / 100),
    capacity: t.capacity == null ? '' : String(t.capacity),
  };
}

export function TiersEditor({
  value,
  onChange,
  disabled,
}: {
  value: TierDraft[];
  onChange: (next: TierDraft[]) => void;
  disabled?: boolean;
}) {
  function update(i: number, patch: Partial<TierDraft>) {
    onChange(value.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  }

  return (
    <div className="flex flex-col gap-3">
      <label className="text-xs font-medium uppercase tracking-wide text-[#475569]">
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
              label="Price (₹)"
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

'use client';

import { Input } from '@/lib/ui';

/**
 * Event-level "Limit tickets per customer" control: a checkbox that reveals a
 * count input. Draft value is `null` when the limit is off, else the input's
 * string (converted to a number on submit via {@link maxPerUserToPayload}).
 */
export function maxPerUserToPayload(value: string | null): number | null {
  if (value == null || !value.trim()) return null;
  return Math.max(1, parseInt(value, 10) || 1);
}

/** Hydrate the draft value from an event's `maxPerUser` (as returned by GET). */
export function maxPerUserFromApi(maxPerUser: number | null): string | null {
  return maxPerUser == null ? null : String(maxPerUser);
}

export function MaxPerUserField({
  value,
  onChange,
  disabled,
}: {
  value: string | null;
  onChange: (next: string | null) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-end gap-3">
      <label className="flex items-center gap-1.5 pb-2 text-xs text-slate-500">
        <input
          type="checkbox"
          checked={value != null}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked ? '1' : null)}
        />
        Limit tickets per customer
      </label>
      {value != null && (
        <div className="w-40">
          <Input
            label="Max tickets per customer"
            type="number"
            min={1}
            inputMode="numeric"
            value={value}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
          />
        </div>
      )}
      {value != null && (
        <p className="basis-full pb-1 text-xs text-slate-500">
          Counts a customer&apos;s tickets across all tiers of this event, including their past
          bookings.
        </p>
      )}
    </div>
  );
}

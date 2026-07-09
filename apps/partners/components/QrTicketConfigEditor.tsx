'use client';

import { Input } from '@/lib/ui';
import type { QrTicketConfig } from '@/lib/api/types';

/** Config emitted when the toggle is first switched on. */
export const DEFAULT_QR_CONFIG: QrTicketConfig = {
  enabled: true,
  multiUse: false,
  maxScans: null,
  validFromOffsetMin: null,
  validUntilOffsetMin: null,
};

/** Blank = null (unlimited / no offset); otherwise a non-negative integer. */
function parseIntOrNull(raw: string): number | null {
  if (!raw.trim()) return null;
  const n = parseInt(raw, 10);
  return Number.isNaN(n) ? null : n;
}

/**
 * The rule fields of an enabled QR config (usage, scan cap, validity offsets).
 * Shared between the listing-level editor below and the per-tier override in
 * MembershipTiersEditor.
 */
export function QrTicketRulesFields({
  cfg,
  onPatch,
  itemNoun = 'listing',
}: {
  cfg: QrTicketConfig;
  onPatch: (p: Partial<QrTicketConfig>) => void;
  itemNoun?: string;
}) {
  return (
    <div className="grid grid-cols-1 gap-3 rounded-[var(--radius)] border border-[#e5e7eb] bg-slate-50 p-3 sm:grid-cols-12">
      <div className="flex flex-col gap-1 sm:col-span-12">
        <label className="text-xs font-medium uppercase tracking-wide text-[#475569]">
          Usage
        </label>
        <div className="inline-flex w-fit rounded-md border border-slate-200 bg-white p-0.5">
          {([false, true] as const).map((multi) => (
            <button
              key={String(multi)}
              type="button"
              onClick={() => onPatch({ multiUse: multi, ...(multi ? {} : { maxScans: null }) })}
              className={[
                'rounded px-3 py-1.5 text-sm font-medium transition-colors',
                cfg.multiUse === multi
                  ? 'bg-slate-900 text-white'
                  : 'text-slate-600 hover:text-slate-900',
              ].join(' ')}
            >
              {multi ? 'Multi-use' : 'Single-use'}
            </button>
          ))}
        </div>
        <p className="text-xs text-[#94a3b8]">
          Single-use passes are spent by their first successful scan.
        </p>
      </div>

      {cfg.multiUse && (
        <div className="sm:col-span-4">
          <Input
            label="Max scans"
            type="number"
            min={1}
            inputMode="numeric"
            placeholder="Blank = unlimited"
            value={cfg.maxScans == null ? '' : String(cfg.maxScans)}
            onChange={(e) => onPatch({ maxScans: parseIntOrNull(e.target.value) })}
            hint="Total scans allowed per pass."
          />
        </div>
      )}
      <div className={cfg.multiUse ? 'sm:col-span-4' : 'sm:col-span-6'}>
        <Input
          label="Valid from (min before start)"
          type="number"
          min={0}
          inputMode="numeric"
          placeholder="Blank = on purchase"
          value={cfg.validFromOffsetMin == null ? '' : String(cfg.validFromOffsetMin)}
          onChange={(e) => onPatch({ validFromOffsetMin: parseIntOrNull(e.target.value) })}
          hint={`Blank = valid immediately after purchase; otherwise minutes before the ${itemNoun} starts.`}
        />
      </div>
      <div className={cfg.multiUse ? 'sm:col-span-4' : 'sm:col-span-6'}>
        <Input
          label="Valid until (min after end)"
          type="number"
          min={0}
          inputMode="numeric"
          placeholder="Blank = at end"
          value={cfg.validUntilOffsetMin == null ? '' : String(cfg.validUntilOffsetMin)}
          onChange={(e) => onPatch({ validUntilOffsetMin: parseIntOrNull(e.target.value) })}
          hint={`Blank = expires when the ${itemNoun} ends; otherwise minutes after.`}
        />
      </div>
    </div>
  );
}

/**
 * Shared editor for the `qrTicketConfig` field on events, arenas, and
 * membership plans. Fully controlled: emits a complete config object while
 * enabled, or `null` when QR tickets are off (which the API stores as
 * "disabled"). Rules only apply to future purchases — issued passes are frozen.
 */
export function QrTicketConfigEditor({
  value,
  onChange,
  itemNoun = 'listing',
  enabledHint,
}: {
  value: QrTicketConfig | null;
  onChange: (v: QrTicketConfig | null) => void;
  /** Noun used in the hint copy, e.g. "event", "arena", "plan". */
  itemNoun?: string;
  /** Overrides the default "When enabled…" hint under the toggle. */
  enabledHint?: string;
}) {
  const enabled = value?.enabled ?? false;
  const cfg = value ?? DEFAULT_QR_CONFIG;

  function patch(p: Partial<QrTicketConfig>) {
    onChange({ ...cfg, enabled: true, ...p });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium uppercase tracking-wide text-[#475569]">
          QR tickets
        </label>
        <div className="inline-flex w-fit rounded-md border border-slate-200 bg-white p-0.5">
          {([false, true] as const).map((on) => (
            <button
              key={String(on)}
              type="button"
              onClick={() => onChange(on ? { ...cfg, enabled: true } : null)}
              className={[
                'rounded px-3 py-1.5 text-sm font-medium transition-colors',
                enabled === on ? 'bg-slate-900 text-white' : 'text-slate-600 hover:text-slate-900',
              ].join(' ')}
            >
              {on ? 'Enabled' : 'Off'}
            </button>
          ))}
        </div>
        <p className="text-xs text-[#94a3b8]">
          {enabledHint ??
            'When enabled, every finalised purchase issues scannable QR passes your staff validate on the Check-in page.'}
        </p>
      </div>

      {enabled && <QrTicketRulesFields cfg={cfg} onPatch={patch} itemNoun={itemNoun} />}
    </div>
  );
}

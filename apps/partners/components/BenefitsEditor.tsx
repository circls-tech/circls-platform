'use client';

import type { MembershipBenefitItem } from '@/lib/api/types';
import { Button } from '@/lib/ui';

/**
 * Structured membership benefits editor (PR #110): add / remove / reorder a list
 * of { label, detail? } rows. Controlled — the parent owns the array.
 */
export function BenefitsEditor({
  items,
  onChange,
}: {
  items: MembershipBenefitItem[];
  onChange: (items: MembershipBenefitItem[]) => void;
}) {
  function update(i: number, patch: Partial<MembershipBenefitItem>) {
    onChange(items.map((it, idx) => (idx === i ? { ...it, ...patch } : it)));
  }
  function remove(i: number) {
    onChange(items.filter((_, idx) => idx !== i));
  }
  function move(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= items.length) return;
    const next = items.slice();
    [next[i], next[j]] = [next[j]!, next[i]!];
    onChange(next);
  }
  function add() {
    onChange([...items, { label: '' }]);
  }

  return (
    <div className="flex flex-col gap-2">
      <label className="text-xs font-medium uppercase tracking-wide text-[#475569]">Benefits</label>
      {items.length === 0 && (
        <p className="text-xs text-slate-400">No benefits yet. Add a few perks members get.</p>
      )}
      <ul className="flex flex-col gap-2">
        {items.map((it, i) => (
          <li key={i} className="flex flex-wrap items-start gap-2 rounded-[var(--radius)] border border-[#e5e7eb] bg-slate-50 p-2">
            <div className="flex min-w-[12rem] flex-1 flex-col gap-1.5">
              <input
                value={it.label}
                onChange={(e) => update(i, { label: e.target.value })}
                placeholder="Benefit (e.g. Priority booking)"
                maxLength={200}
                className="w-full rounded border border-gray-300 px-2 py-1 text-sm"
              />
              <input
                value={it.detail ?? ''}
                onChange={(e) => update(i, { detail: e.target.value || undefined })}
                placeholder="Detail (optional)"
                maxLength={500}
                className="w-full rounded border border-gray-300 px-2 py-1 text-xs"
              />
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => move(i, -1)}
                disabled={i === 0}
                className="rounded border border-gray-200 px-2 py-1 text-xs text-slate-500 disabled:opacity-40 hover:bg-white"
                aria-label="Move up"
              >
                ↑
              </button>
              <button
                type="button"
                onClick={() => move(i, 1)}
                disabled={i === items.length - 1}
                className="rounded border border-gray-200 px-2 py-1 text-xs text-slate-500 disabled:opacity-40 hover:bg-white"
                aria-label="Move down"
              >
                ↓
              </button>
              <button
                type="button"
                onClick={() => remove(i)}
                className="rounded border border-gray-200 px-2 py-1 text-xs text-red-600 hover:bg-white"
              >
                Remove
              </button>
            </div>
          </li>
        ))}
      </ul>
      <div>
        <Button type="button" variant="secondary" size="sm" onClick={add}>
          Add benefit
        </Button>
      </div>
    </div>
  );
}

/** Strip empty rows before sending to the API (labels are required server-side). */
export function cleanBenefits(items: MembershipBenefitItem[]): MembershipBenefitItem[] {
  return items
    .map((it) => ({ label: it.label.trim(), detail: it.detail?.trim() || undefined }))
    .filter((it) => it.label.length > 0)
    .map((it) => (it.detail ? { label: it.label, detail: it.detail } : { label: it.label }));
}

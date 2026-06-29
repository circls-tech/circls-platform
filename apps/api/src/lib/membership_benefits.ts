/**
 * Typed membership benefits (PR #110).
 *
 * The `memberships.benefits` column moved from an opaque jsonb blob to a typed
 * `{ items: [{ label, detail? }] }` shape. The 0027 migration coerces existing
 * rows, but old rows that predate the migration (or anything written by a
 * pre-#110 client) may still carry a legacy blob in memory — so the read path
 * defensively coerces too, matching the migration's rules.
 */
import { z } from 'zod';
import type { MembershipBenefits } from '../db/schema/memberships.js';

export const MAX_BENEFIT_ITEMS = 30;

/** Write-side schema: validate the typed shape on create/update. */
export const benefitItemSchema = z.object({
  label: z.string().min(1).max(200),
  detail: z.string().max(500).optional(),
});

export const benefitsSchema = z.object({
  items: z.array(benefitItemSchema).max(MAX_BENEFIT_ITEMS),
});

/**
 * Coerce any stored/legacy `benefits` value into the typed shape. Mirrors the
 * 0027 backfill so reads stay consistent whether or not the row was migrated:
 *   - already-typed ({items:[...]})  → kept (items re-normalised)
 *   - array (string[] / object[])    → each element becomes an item label
 *   - non-empty object               → each key/value becomes label/detail
 *   - anything else / empty / null   → { items: [] }
 */
export function coerceBenefits(raw: unknown): MembershipBenefits {
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && 'items' in raw) {
    const items = (raw as { items: unknown }).items;
    if (Array.isArray(items)) {
      return { items: items.map(normalizeItem).filter((i): i is { label: string; detail?: string } => i !== null) };
    }
    return { items: [] };
  }
  if (Array.isArray(raw)) {
    return {
      items: raw
        .map((el) => (typeof el === 'string' ? { label: el } : normalizeItem(el)))
        .filter((i): i is { label: string; detail?: string } => i !== null),
    };
  }
  if (raw && typeof raw === 'object') {
    const entries = Object.entries(raw as Record<string, unknown>);
    return {
      items: entries.map(([k, v]) => ({
        label: k,
        ...(typeof v === 'string' ? { detail: v } : v != null ? { detail: JSON.stringify(v) } : {}),
      })),
    };
  }
  return { items: [] };
}

function normalizeItem(el: unknown): { label: string; detail?: string } | null {
  if (typeof el === 'string') return { label: el };
  if (el && typeof el === 'object' && 'label' in el) {
    const label = (el as { label: unknown }).label;
    if (typeof label !== 'string' || label.length === 0) return null;
    const detail = (el as { detail?: unknown }).detail;
    return typeof detail === 'string' && detail.length > 0 ? { label, detail } : { label };
  }
  return null;
}

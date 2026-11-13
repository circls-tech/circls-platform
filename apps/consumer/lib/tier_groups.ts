import type { MembershipTierGroup } from '@/lib/api/types';

/**
 * A membership's tiers as tabs: one per partner-named group, in the partner's
 * order, each with the tiers in it. Tiers outside every group get a last
 * "More options" tab. No groups (or none with tiers) means no tabs: the page
 * shows one list, as before groups existed.
 */
export interface TierTab<T> {
  key: string;
  name: string;
  tagline: string | null;
  tiers: T[];
  /** The cheapest tier's price, for "from ₹X" on the tab. */
  fromPaise: number;
  /** Tailwind background class for the tab's highlight. */
  tint: string;
}

/** Key of the tab holding tiers that aren't in any group. */
export const UNGROUPED_TAB = 'more';

// Listed in full so Tailwind generates each class. The 2026 logo's pastels,
// in the order the brand uses them.
const TINTS = [
  'bg-pastel-salmon',
  'bg-pastel-pink',
  'bg-pastel-sky',
  'bg-pastel-lime',
  'bg-pastel-lilac',
  'bg-pastel-mint',
  'bg-pastel-peach',
  'bg-pastel-butter',
];

export function tierTabs<T extends { groupKey?: string | null; pricePaise: number }>(
  groups: readonly MembershipTierGroup[] | undefined,
  tiers: readonly T[],
): TierTab<T>[] {
  const all = groups ?? [];
  const known = new Set(all.map((g) => g.key));
  const tabs: Omit<TierTab<T>, 'tint'>[] = all.map((g) => ({
    key: g.key,
    name: g.name,
    tagline: g.tagline,
    tiers: tiers.filter((t) => t.groupKey === g.key),
    fromPaise: 0,
  }));
  const loose = tiers.filter((t) => !t.groupKey || !known.has(t.groupKey));
  if (loose.length > 0) {
    tabs.push({ key: UNGROUPED_TAB, name: 'More options', tagline: null, tiers: loose, fromPaise: 0 });
  }
  const shown = tabs.filter((tab) => tab.tiers.length > 0);
  // Only ungrouped tiers left: that's just the plain list.
  if (shown.length === 0 || (shown.length === 1 && shown[0]!.key === UNGROUPED_TAB)) return [];
  return shown.map((tab, i) => ({
    ...tab,
    fromPaise: Math.min(...tab.tiers.map((t) => t.pricePaise)),
    tint: TINTS[i % TINTS.length]!,
  }));
}

/**
 * Tier groups in the portal's forms: a partner names a few groups ("Day
 * Passes", "Punch Passes") and puts each tier in one, so customers choose from
 * a tab per group instead of one long list. Pure helpers; the fields live in
 * components/MembershipTierGroups.tsx.
 */
import type { MembershipTierGroup } from '@/lib/api/types';

export const MAX_TIER_GROUPS = 10;

/**
 * A group in a form. `localId` is what tiers point at while editing; `key` is
 * the saved key (null until first saved), kept on rename so customer links
 * that name the group (?tab=key) keep working.
 */
export interface TierGroupDraft {
  localId: string;
  key: string | null;
  name: string;
  tagline: string;
}

let nextLocalId = 0;
function newLocalId(): string {
  nextLocalId += 1;
  return `new-${Date.now().toString(36)}-${nextLocalId}`;
}

export function emptyTierGroup(): TierGroupDraft {
  return { localId: newLocalId(), key: null, name: '', tagline: '' };
}

/** Saved groups as drafts; a saved group's local id is its key. */
export function tierGroupDraftsFrom(groups: readonly MembershipTierGroup[] | undefined): TierGroupDraft[] {
  return (groups ?? []).map((g) => ({ localId: g.key, key: g.key, name: g.name, tagline: g.tagline ?? '' }));
}

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/, '');
  return slug || 'group';
}

/**
 * The groups as the API takes them, and each draft's key. A new group's key is
 * its name as a slug, made unique among the others; a saved group keeps its
 * key. Groups without a name are left out.
 */
export function resolveTierGroups(drafts: readonly TierGroupDraft[]): {
  groups: MembershipTierGroup[];
  keyOf: (localId: string | null | undefined) => string | null;
} {
  const named = drafts.filter((g) => g.name.trim());
  const taken = new Set(named.flatMap((g) => (g.key ? [g.key] : [])));
  const keys = new Map<string, string>();
  const groups = named.map((g) => {
    let key = g.key;
    if (!key) {
      const base = slugify(g.name);
      key = base;
      for (let n = 2; taken.has(key); n += 1) key = `${base}-${n}`;
      taken.add(key);
    }
    keys.set(g.localId, key);
    return { key, name: g.name.trim(), tagline: g.tagline.trim() || null };
  });
  return { groups, keyOf: (localId) => (localId ? (keys.get(localId) ?? null) : null) };
}

/** Tiers in display order under their groups; ungrouped tiers come last. */
export function tiersByGroup<T extends { groupKey: string | null }>(
  groups: readonly MembershipTierGroup[],
  tiers: readonly T[],
): { group: MembershipTierGroup | null; tiers: T[] }[] {
  const known = new Set(groups.map((g) => g.key));
  const sections = groups.map((g) => ({ group: g as MembershipTierGroup | null, tiers: tiers.filter((t) => t.groupKey === g.key) }));
  const loose = tiers.filter((t) => !t.groupKey || !known.has(t.groupKey));
  if (loose.length > 0) sections.push({ group: null, tiers: loose });
  return sections;
}

/** `list` with the item at `from` moved to `to` (a no-op past either end). */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  if (to < 0 || to >= list.length) return [...list];
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item!);
  return next;
}


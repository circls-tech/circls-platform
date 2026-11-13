/**
 * Plan groups on a membership: the partner names a few groups ("Day Passes",
 * "Punch Passes", …) and puts each plan (tier) in one, so customers pick from
 * a tab per group instead of one long list. Groups live in
 * `memberships.tier_groups`; a plan points at one through
 * `membership_tiers.group_key`.
 */
import { z } from 'zod';
import type { MembershipTierGroup } from '../db/schema/memberships.js';
import { BadRequest } from './errors.js';

export const MAX_TIER_GROUPS = 10;

/** A lowercase slug, so it reads well in a link (`?tab=punch-passes`). */
export const tierGroupKeySchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);

export const tierGroupSchema = z.object({
  key: tierGroupKeySchema,
  name: z.string().trim().min(1).max(40),
  tagline: z
    .string()
    .trim()
    .max(140)
    .nullable()
    .optional()
    .transform((v) => (v ? v : null)),
});

/** Ordered groups; keys and names (ignoring case) must be unique. */
export const tierGroupsField = z
  .array(tierGroupSchema)
  .max(MAX_TIER_GROUPS)
  .superRefine((groups, ctx) => {
    const keys = new Set<string>();
    const names = new Set<string>();
    groups.forEach((g, i) => {
      if (keys.has(g.key)) {
        ctx.addIssue({ code: 'custom', path: [i, 'key'], message: `Duplicate group key "${g.key}"` });
      }
      const name = g.name.toLowerCase();
      if (names.has(name)) {
        ctx.addIssue({ code: 'custom', path: [i, 'name'], message: `Two groups are named "${g.name}"` });
      }
      keys.add(g.key);
      names.add(name);
    });
  });

/** Throws when a plan names a group the membership doesn't have. */
export function assertKnownGroupKeys(
  groups: readonly MembershipTierGroup[],
  groupKeys: readonly (string | null | undefined)[],
): void {
  const known = new Set(groups.map((g) => g.key));
  for (const key of groupKeys) {
    if (key != null && !known.has(key)) {
      throw new BadRequest(`There is no plan group "${key}"`, 'membership_tier_group_unknown', { groupKey: key });
    }
  }
}

/**
 * Fill in the group of each re-sent plan that came without one (`groupKey`
 * undefined: an app that predates groups) from the live plan with the same
 * name, so saving from it doesn't drop the partner's grouping. A carried-over
 * key the membership no longer has becomes null. Plans that came with a
 * `groupKey`, null included, keep it.
 */
export function carryOverGroupKeys<T extends { name: string; groupKey?: string | null | undefined }>(
  previous: readonly { name: string; groupKey: string | null }[],
  next: readonly T[],
  groups: readonly MembershipTierGroup[],
): (T & { groupKey: string | null })[] {
  const known = new Set(groups.map((g) => g.key));
  const byName = new Map(previous.map((t) => [t.name, t.groupKey]));
  return next.map((t) => {
    if (t.groupKey !== undefined) return { ...t, groupKey: t.groupKey };
    const carried = byName.get(t.name) ?? null;
    return { ...t, groupKey: carried && known.has(carried) ? carried : null };
  });
}

/**
 * Groups and plans as customers see them: a group with no plans is dropped,
 * and a plan whose group no longer exists shows ungrouped. Plans keep their
 * order; groups keep the partner's order.
 */
export function customerTierGroups<T extends { groupKey: string | null }>(
  groups: readonly MembershipTierGroup[],
  tiers: readonly T[],
): { groups: MembershipTierGroup[]; tiers: T[] } {
  const known = new Set(groups.map((g) => g.key));
  const shown = tiers.map((t) => (t.groupKey && known.has(t.groupKey) ? t : { ...t, groupKey: null }));
  const used = new Set(shown.map((t) => t.groupKey));
  return { groups: groups.filter((g) => used.has(g.key)), tiers: shown };
}

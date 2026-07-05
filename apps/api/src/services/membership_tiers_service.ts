/**
 * Membership-tier service. Tiers belong to a membership; per-tier sold counts
 * come from `user_memberships.membership_tier_id`. Writes are replace-all and
 * valid only while the membership is editable (the caller — memberships_service
 * — enforces pending_review/inactive). All write helpers take a transaction
 * handle so they compose inside the membership create/update tx.
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { membershipTiers, type MembershipTier } from '../db/schema/membership_tiers.js';
import { memberships, userMemberships } from '../db/schema/memberships.js';
import type { MembershipBenefits } from '../db/schema/memberships.js';
import { BadRequest } from '../lib/errors.js';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Database = typeof db | Tx;

export interface MembershipTierInput {
  name: string;
  description?: string | null;
  pricePaise: number;
  durationDays: number;
  benefits?: MembershipBenefits | null;
  capacity?: number | null;
}

export interface MembershipTierWithRemaining extends MembershipTier {
  sold: number;
  /** capacity - sold, or null when the tier is uncapped. */
  remaining: number | null;
}

/** Live (non-deleted) tiers for a membership, ordered for display. */
export async function listTiers(
  database: Database,
  membershipId: string,
): Promise<MembershipTier[]> {
  return database
    .select()
    .from(membershipTiers)
    .where(and(eq(membershipTiers.membershipId, membershipId), isNull(membershipTiers.deletedAt)))
    .orderBy(membershipTiers.sortOrder, membershipTiers.createdAt);
}

/**
 * Per-tier sold counts for the given tier ids: non-cancelled user_memberships
 * count against their tier's capacity (active + expired hold a seat; cancelled
 * frees it).
 */
export async function soldByTier(
  database: Database,
  tierIds: string[],
): Promise<Map<string, number>> {
  if (tierIds.length === 0) return new Map();
  const rows = await database
    .select({
      tierId: userMemberships.membershipTierId,
      sold: sql<number>`count(*)::int`,
    })
    .from(userMemberships)
    .where(
      and(
        inArray(userMemberships.membershipTierId, tierIds),
        sql`${userMemberships.status} <> 'cancelled'`,
      ),
    )
    .groupBy(userMemberships.membershipTierId);
  const map = new Map<string, number>();
  for (const r of rows) if (r.tierId) map.set(r.tierId, r.sold);
  return map;
}

/** Live tiers enriched with sold/remaining (for consumer + partner reads). */
export async function listTiersWithRemaining(
  database: Database,
  membershipId: string,
): Promise<MembershipTierWithRemaining[]> {
  const tiers = await listTiers(database, membershipId);
  const sold = await soldByTier(database, tiers.map((t) => t.id));
  return tiers.map((t) => {
    const s = sold.get(t.id) ?? 0;
    return { ...t, sold: s, remaining: t.capacity == null ? null : Math.max(0, t.capacity - s) };
  });
}

/**
 * Tiers (with remaining) for several memberships at once — one grouped query,
 * to avoid N+1 when hydrating a list of memberships. Returns a map keyed by
 * membership id; memberships with no live tiers are absent.
 */
export async function tiersWithRemainingByMembership(
  database: Database,
  membershipIds: string[],
): Promise<Map<string, MembershipTierWithRemaining[]>> {
  const out = new Map<string, MembershipTierWithRemaining[]>();
  if (membershipIds.length === 0) return out;
  const tiers = await database
    .select()
    .from(membershipTiers)
    .where(
      and(inArray(membershipTiers.membershipId, membershipIds), isNull(membershipTiers.deletedAt)),
    )
    .orderBy(membershipTiers.sortOrder, membershipTiers.createdAt);
  const sold = await soldByTier(database, tiers.map((t) => t.id));
  for (const t of tiers) {
    const s = sold.get(t.id) ?? 0;
    const enriched: MembershipTierWithRemaining = {
      ...t,
      sold: s,
      remaining: t.capacity == null ? null : Math.max(0, t.capacity - s),
    };
    const list = out.get(t.membershipId);
    if (list) list.push(enriched);
    else out.set(t.membershipId, [enriched]);
  }
  return out;
}

/**
 * Replace a membership's tiers (caller enforces the membership is editable).
 * Soft-deletes the current live set and inserts the provided one fresh; old
 * tiers linger (deletedAt set) so existing buyers keep referencing what they
 * bought. Also syncs the membership's legacy price/duration/benefits to the
 * cheapest tier (used by list cards and existing reads). Returns the new set.
 */
export async function replaceTiers(
  tx: Tx,
  membershipId: string,
  tenantId: string,
  tiers: MembershipTierInput[],
): Promise<MembershipTier[]> {
  if (tiers.length === 0) {
    throw new BadRequest('A membership needs at least one tier', 'membership_tiers_required');
  }
  await tx
    .update(membershipTiers)
    .set({ deletedAt: sql`now()` })
    .where(
      and(eq(membershipTiers.membershipId, membershipId), isNull(membershipTiers.deletedAt)),
    );

  const inserted = await tx
    .insert(membershipTiers)
    .values(
      tiers.map((t, i) => ({
        membershipId,
        tenantId,
        name: t.name,
        description: t.description ?? null,
        pricePaise: t.pricePaise,
        durationDays: t.durationDays,
        benefits: t.benefits ?? { items: [] },
        capacity: t.capacity ?? null,
        sortOrder: i,
      })),
    )
    .returning();

  // Keep the membership's legacy price/duration/benefits in sync with the
  // cheapest tier so cards ("from ₹X / N days") and pre-tier reads stay correct.
  const cheapest = tiers.reduce((a, b) => (b.pricePaise < a.pricePaise ? b : a));
  await tx
    .update(memberships)
    .set({
      pricePaise: cheapest.pricePaise,
      durationDays: cheapest.durationDays,
      benefits: cheapest.benefits ?? { items: [] },
    })
    .where(eq(memberships.id, membershipId));

  return inserted;
}

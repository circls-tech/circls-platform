/**
 * Memberships service stub — Phase 15 owner fills these in.
 *
 * Free memberships skip KYC; paid ones require Tenant KYC verified. Purchase
 * flow: createPurchaseOrder → user pays → webhook activates user_membership.
 */
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { memberships, type Membership } from '../db/schema/memberships.js';

export async function listMembershipsForTenant(tenantId: string): Promise<Membership[]> {
  return db.select().from(memberships).where(eq(memberships.tenantId, tenantId));
}

export async function getMembership(
  membershipId: string,
  tenantId: string,
): Promise<Membership | null> {
  const [row] = await db
    .select()
    .from(memberships)
    .where(and(eq(memberships.id, membershipId), eq(memberships.tenantId, tenantId)))
    .limit(1);
  return row ?? null;
}

export interface CreateMembershipInput {
  tenantId: string;
  venueId?: string | undefined;
  name: string;
  description?: string | undefined;
  pricePaise: number;
  durationDays: number;
  benefits?: Record<string, unknown> | undefined;
}

export async function createMembership(_input: CreateMembershipInput): Promise<Membership> {
  throw new Error('memberships_service.createMembership not implemented — phase 15');
}

export interface PurchaseMembershipInput {
  membershipId: string;
  userId: string;
}

export async function purchaseMembership(
  _input: PurchaseMembershipInput,
): Promise<{ userMembershipId: string; paymentId?: string; orderId?: string }> {
  throw new Error('memberships_service.purchaseMembership not implemented — phase 15');
}

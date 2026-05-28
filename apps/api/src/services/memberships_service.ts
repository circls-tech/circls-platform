/**
 * Memberships service — Phase 15.
 *
 * Free memberships skip KYC and activate instantly. Paid memberships require
 * tenant.kyc_status='verified', insert a `payments` row of kind='charge', and
 * call `payments_service.createRouteOrder` so the Phase 12 webhook can move
 * the payment from 'pending' → 'captured' once the customer pays.
 *
 * Simplification (documented): the `user_membership_status` enum doesn't have
 * a 'pending' value, so paid purchases insert a `user_memberships` row with
 * status='active' immediately. The payment_id linkage discriminates "really
 * paid" from "awaiting capture" — a future migration can add 'pending' and the
 * webhook can flip it to 'active'. For the walk-in/MVP flow this is good
 * enough; the consumer Flutter app will gate access via payment status.
 */
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { memberships, type Membership, userMemberships } from '../db/schema/memberships.js';
import { bookings } from '../db/schema/bookings.js';
import { payments } from '../db/schema/payments.js';
import { tenants } from '../db/schema/tenants.js';
import { writeAudit } from '../lib/audit.js';
import { Conflict, NotFound } from '../lib/errors.js';
import * as paymentsService from './payments_service.js';

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
  actorUserId: string;
  venueId?: string | undefined;
  name: string;
  description?: string | undefined;
  pricePaise: number;
  durationDays: number;
  benefits?: Record<string, unknown> | undefined;
}

export async function createMembership(input: CreateMembershipInput): Promise<Membership> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(memberships)
      .values({
        tenantId: input.tenantId,
        venueId: input.venueId ?? null,
        name: input.name,
        description: input.description ?? null,
        pricePaise: input.pricePaise,
        durationDays: input.durationDays,
        benefits: input.benefits ?? {},
      })
      .returning();
    if (!row) throw new Error('membership insert returned no row');

    await writeAudit(
      tx,
      { tenantId: input.tenantId, actorUserId: input.actorUserId },
      'membership.created',
      'membership',
      row.id,
      null,
      {
        name: row.name,
        pricePaise: row.pricePaise,
        durationDays: row.durationDays,
        venueId: row.venueId,
      },
    );

    return row;
  });
}

export interface PurchaseMembershipInput {
  membershipId: string;
  userId: string;
}

export interface PurchaseMembershipResult {
  userMembershipId: string;
  paymentId?: string;
  orderId?: string;
}

/**
 * Purchase a membership.
 *
 * Free path (pricePaise === 0):
 *   - Insert `user_memberships` with status='active' immediately.
 *   - No KYC required, no payment row.
 *
 * Paid path:
 *   - Tenant must have kyc_status='verified'; otherwise `kyc_required`.
 *   - Tenant must have a Razorpay Linked Account id; otherwise `kyc_required`.
 *   - We synthesize a `bookings` row (item_type='membership', status='pending')
 *     because `payments.booking_id` is NOT NULL — payments hangs off bookings
 *     across the system, and memberships reuse that ledger to keep refund /
 *     reconciliation code paths identical.
 *   - Insert `user_memberships` status='active' with payment_id set.
 *   - Call `payments_service.createRouteOrder` to mint the Razorpay order.
 *
 * If the Phase 12 stub still throws, we surface `payment_not_available` so
 * callers (and tests) can distinguish "not implemented" from "really failed".
 */
export async function purchaseMembership(
  input: PurchaseMembershipInput,
): Promise<PurchaseMembershipResult> {
  return db.transaction(async (tx) => {
    const [m] = await tx
      .select()
      .from(memberships)
      .where(eq(memberships.id, input.membershipId))
      .limit(1);
    if (!m) throw new NotFound('Membership not found', 'membership_not_found');

    const now = new Date();
    const endsAt = new Date(now.getTime() + m.durationDays * 24 * 60 * 60 * 1000);

    if (m.pricePaise === 0) {
      const [um] = await tx
        .insert(userMemberships)
        .values({
          userId: input.userId,
          membershipId: m.id,
          paymentId: null,
          startsAt: now,
          endsAt,
          status: 'active',
        })
        .returning();
      if (!um) throw new Error('user_membership insert returned no row');

      await writeAudit(
        tx,
        { tenantId: m.tenantId, actorUserId: input.userId },
        'membership.purchased',
        'user_membership',
        um.id,
        null,
        { membershipId: m.id, pricePaise: 0, free: true },
      );

      return { userMembershipId: um.id };
    }

    // Paid path — require KYC + linked account.
    const [tenant] = await tx
      .select({
        kycStatus: tenants.kycStatus,
        linkedAccountId: tenants.razorpayLinkedAccountId,
      })
      .from(tenants)
      .where(eq(tenants.id, m.tenantId))
      .limit(1);
    if (!tenant) throw new NotFound('Tenant not found', 'tenant_not_found');
    if (tenant.kycStatus !== 'verified' || !tenant.linkedAccountId) {
      throw new Conflict('Tenant KYC not verified', 'kyc_required');
    }

    // Create a `bookings` row to anchor the payment (payments.booking_id is NOT NULL).
    const [b] = await tx
      .insert(bookings)
      .values({
        tenantId: m.tenantId,
        venueId: m.venueId,
        itemType: 'membership',
        channel: 'circls',
        paymentMethod: 'razorpay_route',
        status: 'pending',
        customerUserId: input.userId,
        pricePaise: m.pricePaise,
        totalPaise: m.pricePaise,
        itemData: { membershipId: m.id },
      })
      .returning();
    if (!b) throw new Error('booking insert returned no row');

    // Insert a pending payment row up-front so it's visible in ledger reads;
    // the actual provider order is minted via payments_service.
    const [p] = await tx
      .insert(payments)
      .values({
        bookingId: b.id,
        tenantId: m.tenantId,
        provider: 'razorpay',
        amountPaise: m.pricePaise,
        currency: 'INR',
        status: 'pending',
        kind: 'charge',
        metadata: { membershipId: m.id, userId: input.userId },
      })
      .returning();
    if (!p) throw new Error('payment insert returned no row');

    const [um] = await tx
      .insert(userMemberships)
      .values({
        userId: input.userId,
        membershipId: m.id,
        paymentId: p.id,
        startsAt: now,
        endsAt,
        status: 'active',
      })
      .returning();
    if (!um) throw new Error('user_membership insert returned no row');

    await writeAudit(
      tx,
      { tenantId: m.tenantId, actorUserId: input.userId },
      'membership.purchased',
      'user_membership',
      um.id,
      null,
      { membershipId: m.id, pricePaise: m.pricePaise, paymentId: p.id, free: false },
    );

    // Call out to Phase 12's payment-order minting. Wrap so an unimplemented
    // stub surfaces a friendly error code instead of a generic 500.
    let orderId: string | undefined;
    try {
      const result = await paymentsService.createRouteOrder({
        bookingId: b.id,
        tenantId: m.tenantId,
        amountPaise: m.pricePaise,
        linkedAccountId: tenant.linkedAccountId,
        platformFeePaise: 0,
      });
      orderId = result.providerOrderId;
    } catch (err) {
      // If Phase 12 isn't ready yet, surface a typed error rather than rolling
      // back a successful purchase — but in fact roll back via thrown error so
      // the user sees a clean state.
      if (err instanceof Error && err.message.includes('not implemented')) {
        throw new Conflict('Payments not yet enabled', 'payment_not_available');
      }
      throw err;
    }

    return { userMembershipId: um.id, paymentId: p.id, orderId };
  });
}

export interface UserMembershipWithMembership {
  id: string;
  userId: string;
  membershipId: string;
  paymentId: string | null;
  startsAt: Date;
  endsAt: Date;
  status: 'active' | 'expired' | 'cancelled';
  membership: {
    id: string;
    tenantId: string;
    venueId: string | null;
    name: string;
    description: string | null;
    pricePaise: number;
    durationDays: number;
  };
}

/** Returns the user's active memberships joined with the membership catalog row. */
export async function listUserMemberships(userId: string): Promise<UserMembershipWithMembership[]> {
  const rows = await db
    .select({
      um: userMemberships,
      m: memberships,
    })
    .from(userMemberships)
    .innerJoin(memberships, eq(userMemberships.membershipId, memberships.id))
    .where(and(eq(userMemberships.userId, userId), eq(userMemberships.status, 'active')));

  return rows.map((r) => ({
    id: r.um.id,
    userId: r.um.userId,
    membershipId: r.um.membershipId,
    paymentId: r.um.paymentId,
    startsAt: r.um.startsAt,
    endsAt: r.um.endsAt,
    status: r.um.status,
    membership: {
      id: r.m.id,
      tenantId: r.m.tenantId,
      venueId: r.m.venueId,
      name: r.m.name,
      description: r.m.description,
      pricePaise: r.m.pricePaise,
      durationDays: r.m.durationDays,
    },
  }));
}

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
        // New listings await Circls review before going live (subproject B).
        status: 'pending_review',
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

export interface UpdateMembershipPatch {
  name?: string;
  description?: string | null;
  pricePaise?: number;
  durationDays?: number;
  venueId?: string | null;
  benefits?: Record<string, unknown>;
}

/**
 * Edit a membership's fields. Allowed only when it's not consumer-live
 * (pending_review or inactive) — a live (`active`) one must be deactivated
 * first, so its public price/terms don't change underneath buyers.
 */
export async function updateMembership(
  ctx: { tenantId: string; actorUserId: string },
  membershipId: string,
  patch: UpdateMembershipPatch,
): Promise<Membership> {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(memberships)
      .where(and(eq(memberships.id, membershipId), eq(memberships.tenantId, ctx.tenantId)))
      .limit(1);
    if (!existing) throw new NotFound('Membership not found', 'membership_not_found');
    if (existing.status !== 'pending_review' && existing.status !== 'inactive') {
      throw new Conflict(
        `A ${existing.status} membership can't be edited — deactivate it first`,
        'membership_not_editable',
        { status: existing.status },
      );
    }

    const set: Partial<typeof memberships.$inferInsert> = {};
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.description !== undefined) set.description = patch.description;
    if (patch.pricePaise !== undefined) set.pricePaise = patch.pricePaise;
    if (patch.durationDays !== undefined) set.durationDays = patch.durationDays;
    if (patch.venueId !== undefined) set.venueId = patch.venueId;
    if (patch.benefits !== undefined) set.benefits = patch.benefits;
    if (Object.keys(set).length > 0) {
      await tx.update(memberships).set(set).where(eq(memberships.id, membershipId));
    }

    const [updated] = await tx
      .select()
      .from(memberships)
      .where(eq(memberships.id, membershipId))
      .limit(1);
    await writeAudit(
      tx,
      ctx,
      'membership.updated',
      'membership',
      membershipId,
      existing as unknown as Record<string, unknown>,
      set,
    );
    return updated!;
  });
}

/**
 * Toggle an approved membership between active (live) and inactive. The
 * approval states (pending_review/rejected) are admin-controlled and can't be
 * toggled here.
 */
export async function setMembershipActive(
  ctx: { tenantId: string; actorUserId: string },
  membershipId: string,
  active: boolean,
): Promise<Membership> {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(memberships)
      .where(and(eq(memberships.id, membershipId), eq(memberships.tenantId, ctx.tenantId)))
      .limit(1);
    if (!existing) throw new NotFound('Membership not found', 'membership_not_found');
    const from = active ? 'inactive' : 'active';
    const to = active ? 'active' : 'inactive';
    if (existing.status !== from) {
      throw new Conflict(
        `Cannot ${active ? 'activate' : 'deactivate'} a ${existing.status} membership`,
        'membership_bad_transition',
        { status: existing.status },
      );
    }
    const [updated] = await tx
      .update(memberships)
      .set({ status: to })
      .where(eq(memberships.id, membershipId))
      .returning();
    await writeAudit(
      tx,
      ctx,
      active ? 'membership.activated' : 'membership.deactivated',
      'membership',
      membershipId,
      { status: from },
      { status: to },
    );
    return updated!;
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
 *   - Circls is the merchant — no per-tenant KYC / Linked Account gate.
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
  // Phase 1 — atomic reserve. Free memberships finish here; paid ones return
  // their booking + user_membership ids for the Phase 2 createRouteOrder call.
  const reserved = await db.transaction(async (tx) => {
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

      return { kind: 'free' as const, userMembershipId: um.id };
    }

    // Paid path — Circls is the merchant, no per-tenant KYC / Linked Account.
    // Synthetic bookings row anchors the payment (payments.booking_id NOT NULL).
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

    const [um] = await tx
      .insert(userMemberships)
      .values({
        userId: input.userId,
        membershipId: m.id,
        paymentId: null, // patched in Phase 2 once createRouteOrder returns
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
      { membershipId: m.id, pricePaise: m.pricePaise, free: false, bookingId: b.id },
    );

    return {
      kind: 'paid' as const,
      bookingId: b.id,
      userMembershipId: um.id,
      tenantId: m.tenantId,
      pricePaise: m.pricePaise,
      membershipId: m.id,
    };
  });

  if (reserved.kind === 'free') {
    return { userMembershipId: reserved.userMembershipId };
  }

  // Phase 2 — paid: createRouteOrder runs OUTSIDE the booking tx so the FK to
  // bookings is satisfied (createRouteOrder inserts a payments row referencing
  // bookingId). Mirrors the bookEvent / prepareOnlineBookingWithPayment split.
  let orderId: string | undefined;
  let paymentId: string | undefined;
  try {
    const result = await paymentsService.createRouteOrder({
      bookingId: reserved.bookingId,
      tenantId: reserved.tenantId,
      amountPaise: reserved.pricePaise,
      actorUserId: input.userId,
    });
    orderId = result.providerOrderId;
    paymentId = result.paymentId;
  } catch (err) {
    if (err instanceof Error && err.message.includes('not implemented')) {
      throw new Conflict('Payments not yet enabled', 'payment_not_available');
    }
    throw err;
  }

  // Stitch the payment id onto the user_membership now that it exists.
  if (paymentId) {
    await db
      .update(userMemberships)
      .set({ paymentId })
      .where(eq(userMemberships.id, reserved.userMembershipId));
  }

  return { userMembershipId: reserved.userMembershipId, paymentId, orderId };
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

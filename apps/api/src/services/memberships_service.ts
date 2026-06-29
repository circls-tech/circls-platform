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
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { env } from '../config/env.js';
import {
  memberships,
  type Membership,
  type MembershipBenefits,
  userMemberships,
} from '../db/schema/memberships.js';
import { bookings } from '../db/schema/bookings.js';
import { tenants } from '../db/schema/tenants.js';
import { writeAudit } from '../lib/audit.js';
import { Conflict, NotFound } from '../lib/errors.js';
import { getStorage } from '../lib/storage.js';
import * as paymentsService from './payments_service.js';
import { computeCheckout } from './checkout_pricing.js';
import { recordRedemption } from './coupon_service.js';
import type { CouponPricing } from './booking_service.js';

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

export interface MembershipPurchaseRow {
  userMembershipId: string;
  buyerName: string | null;
  buyerContact: string | null;
  status: string;
  startsAt: string;
  endsAt: string;
  createdAt: string;
}

/**
 * Buyers of a membership (partner-facing). Joins user_memberships → users; the
 * buyer's display name / phone / email are surfaced for the partner's records.
 * Tenant-scoped via the parent membership.
 */
export async function listMembershipPurchases(
  tenantId: string,
  membershipId: string,
): Promise<MembershipPurchaseRow[]> {
  const raw = await db.execute<Record<string, unknown>>(sql`
    select um.id, um.status, um.starts_at, um.ends_at, um.created_at,
           u.display_name, u.phone_e164, u.email
    from user_memberships um
    join memberships m on m.id = um.membership_id
    join users u on u.id = um.user_id
    where m.tenant_id = ${tenantId} and um.membership_id = ${membershipId}
    order by um.created_at desc
    limit 500
  `);
  const rows = raw as unknown as Record<string, unknown>[];
  return rows.map((r) => ({
    userMembershipId: r['id'] as string,
    buyerName: (r['display_name'] as string | null) ?? null,
    buyerContact: ((r['phone_e164'] as string | null) ?? (r['email'] as string | null)) ?? null,
    status: r['status'] as string,
    startsAt: new Date(r['starts_at'] as string).toISOString(),
    endsAt: new Date(r['ends_at'] as string).toISOString(),
    createdAt: new Date(r['created_at'] as string).toISOString(),
  }));
}

export interface CreateMembershipInput {
  tenantId: string;
  actorUserId: string;
  venueId?: string | undefined;
  name: string;
  description?: string | undefined;
  pricePaise: number;
  durationDays: number;
  benefits?: MembershipBenefits | undefined;
  terms?: string | null | undefined;
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
        benefits: input.benefits ?? { items: [] },
        terms: input.terms ?? null,
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
  benefits?: MembershipBenefits;
  terms?: string | null;
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
    if (patch.terms !== undefined) set.terms = patch.terms;
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
  /** Razorpay publishable key + amount, so the client can open checkout. */
  keyId?: string;
  amountPaise?: number;
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
  pricing?: CouponPricing | null,
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

    // Money model: discount + gross-up. A 100%/over-base coupon makes a paid
    // membership free; isFree derives from the grossed-up total, not the base.
    const basePaise = m.pricePaise;
    const breakdown = computeCheckout(
      basePaise,
      pricing
        ? {
            discountType: pricing.coupon.discountType,
            discountValue: pricing.coupon.discountValue,
            maxDiscountPaise: pricing.coupon.maxDiscountPaise,
          }
        : null,
    );
    const isFree = breakdown.totalPaise === 0;
    const settleBasePaise = pricing && pricing.funder === 'platform' ? basePaise : breakdown.discountedBasePaise;

    // A coupon redemption must reference a bookings row (FK NOT NULL). The
    // original free path skipped the synthetic booking; we still skip it when
    // free AND no coupon, but mint one when a coupon makes the purchase free so
    // the redemption has something to anchor on.
    if (isFree && !pricing) {
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

    // Circls is the merchant, no per-tenant KYC / Linked Account.
    // Synthetic bookings row anchors the payment (payments.booking_id NOT NULL)
    // and any coupon redemption.
    const [b] = await tx
      .insert(bookings)
      .values({
        tenantId: m.tenantId,
        venueId: m.venueId,
        itemType: 'membership',
        channel: 'circls',
        paymentMethod: isFree ? 'free' : 'razorpay_route',
        status: isFree ? 'confirmed' : 'pending',
        customerUserId: input.userId,
        pricePaise: basePaise,
        basePaise,
        discountPaise: breakdown.discountPaise,
        couponId: pricing?.coupon.id ?? null,
        totalPaise: breakdown.totalPaise,
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

    if (pricing) {
      await recordRedemption(tx, {
        coupon: pricing.coupon,
        bookingId: b.id,
        userId: input.userId,
        tenantId: m.tenantId,
        basePaise,
        discountPaise: breakdown.discountPaise,
        funder: pricing.funder,
      });
    }

    await writeAudit(
      tx,
      { tenantId: m.tenantId, actorUserId: input.userId },
      'membership.purchased',
      'user_membership',
      um.id,
      null,
      { membershipId: m.id, pricePaise: basePaise, totalPaise: breakdown.totalPaise, free: isFree, bookingId: b.id },
    );

    // A coupon-driven free membership finishes here — no Razorpay order.
    if (isFree) {
      return { kind: 'free' as const, userMembershipId: um.id };
    }

    return {
      kind: 'paid' as const,
      bookingId: b.id,
      userMembershipId: um.id,
      tenantId: m.tenantId,
      totalPaise: breakdown.totalPaise,
      settleBasePaise,
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
      amountPaise: reserved.totalPaise,
      settleBasePaise: reserved.settleBasePaise,
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

  return {
    userMembershipId: reserved.userMembershipId,
    paymentId,
    orderId,
    keyId: env.RAZORPAY_KEY_ID ?? '',
    amountPaise: reserved.totalPaise,
  };
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

// ── Membership artwork (PR #110) ──────────────────────────────────────────────
// Single cover image per membership, finalized via presign+HEAD like venue
// images. JPEG/PNG/WebP, ≤10 MiB.

const COVER_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};
const MAX_COVER_BYTES = 10 * 1024 * 1024; // 10 MiB

function coverPrefix(membershipId: string): string {
  return `memberships/${membershipId}/cover/`;
}

/** Tenant-scoped fetch so the route can authz before touching artwork. */
async function getMembershipForTenant(tenantId: string, membershipId: string): Promise<Membership> {
  const [m] = await db
    .select()
    .from(memberships)
    .where(and(eq(memberships.id, membershipId), eq(memberships.tenantId, tenantId)))
    .limit(1);
  if (!m) throw new NotFound('Membership not found', 'membership_not_found');
  return m;
}

export async function presignMembershipCover(
  tenantId: string,
  membershipId: string,
  contentType: string,
) {
  await getMembershipForTenant(tenantId, membershipId);
  const ext = COVER_TYPES[contentType];
  if (!ext) {
    throw new Conflict(
      `Unsupported image type "${contentType}" (allowed: ${Object.keys(COVER_TYPES).join(', ')})`,
      'unsupported_media_type',
    );
  }
  const key = `${coverPrefix(membershipId)}${randomUUID()}.${ext}`;
  return getStorage().presignUpload({ key, contentType });
}

export async function finalizeMembershipCover(
  tenantId: string,
  membershipId: string,
  storageKey: string,
): Promise<Membership> {
  const existing = await getMembershipForTenant(tenantId, membershipId);
  if (!storageKey.startsWith(coverPrefix(membershipId))) {
    throw new Conflict('storageKey does not belong to this membership', 'bad_storage_key');
  }
  const storage = getStorage();
  const head = await storage.head(storageKey);
  if (!head) throw new Conflict('No uploaded object found for that storageKey', 'upload_not_found');
  if (!COVER_TYPES[head.contentType]) {
    await storage.delete(storageKey);
    throw new Conflict(
      `Uploaded object is "${head.contentType}", not an allowed image type`,
      'unsupported_media_type',
    );
  }
  if (head.sizeBytes > MAX_COVER_BYTES) {
    await storage.delete(storageKey);
    throw new Conflict(`Image is ${head.sizeBytes} bytes; max is ${MAX_COVER_BYTES}`, 'image_too_large');
  }
  const [row] = await db
    .update(memberships)
    .set({ coverStorageKey: storageKey })
    .where(eq(memberships.id, membershipId))
    .returning();
  if (!row) throw new NotFound('Membership not found', 'membership_not_found');
  if (existing.coverStorageKey && existing.coverStorageKey !== storageKey) {
    await storage.delete(existing.coverStorageKey).catch(() => {});
  }
  return row;
}

export async function removeMembershipCover(
  tenantId: string,
  membershipId: string,
): Promise<Membership> {
  const existing = await getMembershipForTenant(tenantId, membershipId);
  const [row] = await db
    .update(memberships)
    .set({ coverStorageKey: null })
    .where(eq(memberships.id, membershipId))
    .returning();
  if (!row) throw new NotFound('Membership not found', 'membership_not_found');
  if (existing.coverStorageKey) {
    await getStorage().delete(existing.coverStorageKey).catch(() => {});
  }
  return row;
}

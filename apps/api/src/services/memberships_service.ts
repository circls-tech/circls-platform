/**
 * Memberships service — Phase 15.
 *
 * Free memberships skip KYC and activate instantly. Paid memberships require
 * tenant.kyc_status='verified', insert a `payments` row of kind='charge', and
 * call `payments_service.createPaymentOrder` so the Phase 12 webhook can move
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
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  memberships,
  type Membership,
  type MembershipBenefits,
  userMemberships,
} from '../db/schema/memberships.js';
import type { QrTicketConfig } from '../db/schema/qr_ticket_config.js';
import { membershipTiers } from '../db/schema/membership_tiers.js';
import { qrTickets } from '../db/schema/qr_tickets.js';
import { bookings } from '../db/schema/bookings.js';
import { tenants } from '../db/schema/tenants.js';
import { writeAudit } from '../lib/audit.js';
import { BadRequest, Conflict, NotFound } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { getStorage } from '../lib/storage.js';
import { publicKeyIdFor, type PaymentProviderId } from '../lib/gateway.js';
import * as paymentsService from './payments_service.js';
import { onBookingConfirmed } from './notification_hooks.js';
import { issueQrTicketsForUserMembership, qrTicketDataUrl } from './qr_ticket_service.js';
import { computeCheckout } from './checkout_pricing.js';
import { recordRedemption } from './coupon_service.js';
import type { CouponPricing } from './booking_service.js';
import {
  listTiersWithRemaining,
  replaceTiers,
  tiersWithRemainingByMembership,
  type MembershipTierInput,
  type MembershipTierWithRemaining,
} from './membership_tiers_service.js';

/** Partner-facing membership row enriched with the derived artwork URL (PR #110). */
export interface PartnerMembership extends Membership {
  coverUrl: string | null;
}

/** Partner-facing membership with its live plan tiers attached. */
export type PartnerMembershipWithTiers = PartnerMembership & {
  tiers: MembershipTierWithRemaining[];
};

function withCoverUrl(m: Membership): PartnerMembership {
  return { ...m, coverUrl: m.coverStorageKey ? getStorage().publicUrl(m.coverStorageKey) : null };
}

export async function listMembershipsForTenant(
  tenantId: string,
): Promise<PartnerMembershipWithTiers[]> {
  const rows = await db.select().from(memberships).where(eq(memberships.tenantId, tenantId));
  const byMembership = await tiersWithRemainingByMembership(db, rows.map((r) => r.id));
  return rows.map((r) => ({ ...withCoverUrl(r), tiers: byMembership.get(r.id) ?? [] }));
}

export async function getMembership(
  membershipId: string,
  tenantId: string,
): Promise<PartnerMembershipWithTiers | null> {
  const [row] = await db
    .select()
    .from(memberships)
    .where(and(eq(memberships.id, membershipId), eq(memberships.tenantId, tenantId)))
    .limit(1);
  if (!row) return null;
  const tiers = await listTiersWithRemaining(db, membershipId);
  return { ...withCoverUrl(row), tiers };
}

export interface MembershipPurchaseRow {
  userMembershipId: string;
  buyerName: string | null;
  buyerContact: string | null;
  /** The tier the buyer purchased, or null for legacy/no-tier purchases. */
  tierName: string | null;
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
           u.display_name, u.phone_e164, u.email, mt.name as tier_name
    from user_memberships um
    join memberships m on m.id = um.membership_id
    join users u on u.id = um.user_id
    left join membership_tiers mt on mt.id = um.membership_tier_id
    where m.tenant_id = ${tenantId} and um.membership_id = ${membershipId}
    order by um.created_at desc
    limit 500
  `);
  const rows = raw as unknown as Record<string, unknown>[];
  return rows.map((r) => ({
    userMembershipId: r['id'] as string,
    buyerName: (r['display_name'] as string | null) ?? null,
    buyerContact: ((r['phone_e164'] as string | null) ?? (r['email'] as string | null)) ?? null,
    tierName: (r['tier_name'] as string | null) ?? null,
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
  terms?: string | null | undefined;
  /**
   * Plan tiers (min 1). When omitted, a single "Standard" tier is synthesized
   * from the legacy `pricePaise`/`durationDays`/`benefits` fields so older
   * callers and tests keep working.
   */
  tiers?: MembershipTierInput[] | undefined;
  pricePaise?: number | undefined;
  durationDays?: number | undefined;
  benefits?: MembershipBenefits | undefined;
  /** QR entry-ticket rules (null/omitted = disabled). */
  qrTicketConfig?: QrTicketConfig | null | undefined;
}

/** Resolve the create payload's tiers, falling back to a single legacy tier. */
function resolveCreateTiers(input: CreateMembershipInput): MembershipTierInput[] {
  if (input.tiers && input.tiers.length > 0) return input.tiers;
  if (input.pricePaise === undefined || input.durationDays === undefined) {
    throw new BadRequest('A membership needs at least one tier', 'membership_tiers_required');
  }
  return [
    {
      name: 'Standard',
      description: input.description ?? null,
      pricePaise: input.pricePaise,
      durationDays: input.durationDays,
      benefits: input.benefits ?? { items: [] },
      capacity: null,
    },
  ];
}

export async function createMembership(
  input: CreateMembershipInput,
): Promise<PartnerMembershipWithTiers> {
  const tiers = resolveCreateTiers(input);
  const cheapest = tiers.reduce((a, b) => (b.pricePaise < a.pricePaise ? b : a));
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(memberships)
      .values({
        tenantId: input.tenantId,
        venueId: input.venueId ?? null,
        name: input.name,
        description: input.description ?? null,
        // Legacy display fields, kept in sync with the cheapest tier.
        pricePaise: cheapest.pricePaise,
        durationDays: cheapest.durationDays,
        benefits: cheapest.benefits ?? { items: [] },
        terms: input.terms ?? null,
        qrTicketConfig: input.qrTicketConfig ?? null,
        // New listings await Circls review before going live (subproject B).
        status: 'pending_review',
      })
      .returning();
    if (!row) throw new Error('membership insert returned no row');

    const liveTiers = await replaceTiers(tx, row.id, input.tenantId, tiers);

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
        tierCount: liveTiers.length,
      },
    );

    return {
      ...withCoverUrl(row),
      tiers: liveTiers.map((t) => ({ ...t, sold: 0, remaining: t.capacity })),
    };
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
  /** null clears (QR tickets off); omitted = unchanged. */
  qrTicketConfig?: QrTicketConfig | null;
  /** When provided, replaces all plan tiers (editable states only). */
  tiers?: MembershipTierInput[];
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
): Promise<PartnerMembershipWithTiers> {
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
    if (patch.qrTicketConfig !== undefined) set.qrTicketConfig = patch.qrTicketConfig;
    if (Object.keys(set).length > 0) {
      await tx.update(memberships).set(set).where(eq(memberships.id, membershipId));
    }

    // Replacing tiers also re-syncs the membership's legacy price/duration/benefits.
    if (patch.tiers !== undefined) {
      await replaceTiers(tx, membershipId, ctx.tenantId, patch.tiers);
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
    const tiers = await listTiersWithRemaining(tx, membershipId);
    return { ...withCoverUrl(updated!), tiers };
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
  /**
   * The tier to buy. When omitted, the cheapest live tier is used (so a
   * single-tier membership "just works"). Price, duration and capacity come
   * from the resolved tier.
   */
  membershipTierId?: string | undefined;
}

export interface PurchaseMembershipResult {
  userMembershipId: string;
  paymentId?: string;
  orderId?: string;
  /** Which gateway the order was minted on (paid only). */
  gateway?: PaymentProviderId;
  /** The gateway's browser-safe key + amount, so the client can open checkout. */
  keyId?: string;
  /** Stripe only: what the browser needs to confirm the PaymentIntent. */
  clientSecret?: string | undefined;
  amountPaise?: number;
  currency?: string;
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
 *   - Call `payments_service.createPaymentOrder` to mint the gateway order.
 *
 * If the Phase 12 stub still throws, we surface `payment_not_available` so
 * callers (and tests) can distinguish "not implemented" from "really failed".
 */
export async function purchaseMembership(
  input: PurchaseMembershipInput,
  pricing?: CouponPricing | null,
): Promise<PurchaseMembershipResult> {
  // Phase 1 — atomic reserve. Free memberships finish here; paid ones return
  // their booking + user_membership ids for the Phase 2 createPaymentOrder call.
  const reserved = await db.transaction(async (tx) => {
    const [m] = await tx
      .select()
      .from(memberships)
      .where(eq(memberships.id, input.membershipId))
      .limit(1);
    if (!m) throw new NotFound('Membership not found', 'membership_not_found');

    // Resolve the tier being bought: the requested one, else the cheapest live
    // tier. Price/duration/capacity all come from this tier.
    const liveTiers = await tx
      .select()
      .from(membershipTiers)
      .where(and(eq(membershipTiers.membershipId, m.id), isNull(membershipTiers.deletedAt)))
      .orderBy(membershipTiers.pricePaise);
    const tier = input.membershipTierId
      ? liveTiers.find((t) => t.id === input.membershipTierId)
      : liveTiers[0];
    if (input.membershipTierId && !tier) {
      throw new NotFound('Membership tier not found', 'membership_tier_not_found');
    }

    // Capacity is per-tier (null = unlimited). Count non-cancelled holders of
    // this tier inside the tx so concurrent buys can't oversell (best-effort).
    if (tier && tier.capacity != null) {
      const [{ sold } = { sold: 0 }] = await tx
        .select({ sold: sql<number>`count(*)::int` })
        .from(userMemberships)
        .where(
          and(
            eq(userMemberships.membershipTierId, tier.id),
            sql`${userMemberships.status} <> 'cancelled'`,
          ),
        );
      if (sold >= tier.capacity) {
        throw new Conflict('This tier is sold out', 'membership_tier_sold_out');
      }
    }

    // Fall back to the membership's legacy fields only when it has no tiers.
    const tierId = tier?.id ?? null;
    const durationDays = tier?.durationDays ?? m.durationDays;
    const now = new Date();
    const endsAt = new Date(now.getTime() + durationDays * 24 * 60 * 60 * 1000);

    // Gateway + currency follow the membership's venue country when venue-
    // scoped, else the owning tenant's country.
    const payCtx = await paymentsService.resolvePaymentContext(
      { venueId: m.venueId, tenantId: m.tenantId },
      tx,
    );

    // Money model: discount + gross-up. A 100%/over-base coupon makes a paid
    // membership free; isFree derives from the grossed-up total, not the base.
    const basePaise = tier?.pricePaise ?? m.pricePaise;
    const breakdown = computeCheckout(
      basePaise,
      pricing
        ? {
            discountType: pricing.coupon.discountType,
            discountValue: pricing.coupon.discountValue,
            maxDiscountPaise: pricing.coupon.maxDiscountPaise,
          }
        : null,
      payCtx.provider,
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
          membershipTierId: tierId,
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
        { membershipId: m.id, membershipTierId: tierId, pricePaise: 0, free: true },
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
        currency: payCtx.currency,
        itemData: { membershipId: m.id },
      })
      .returning();
    if (!b) throw new Error('booking insert returned no row');

    const [um] = await tx
      .insert(userMemberships)
      .values({
        userId: input.userId,
        membershipId: m.id,
        membershipTierId: tierId,
        paymentId: null, // patched in Phase 2 once createPaymentOrder returns
        startsAt: now,
        endsAt,
        status: 'active',
      })
      .returning();
    if (!um) throw new Error('user_membership insert returned no row');

    // Stamp the user_membership onto the booking so booking-keyed consumers
    // (QR issuance, reads) can resolve the purchase without a payment join.
    await tx
      .update(bookings)
      .set({ itemData: { membershipId: m.id, userMembershipId: um.id } })
      .where(eq(bookings.id, b.id));

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
      { membershipId: m.id, membershipTierId: tierId, pricePaise: basePaise, totalPaise: breakdown.totalPaise, free: isFree, bookingId: b.id },
    );

    // A coupon-driven free membership finishes here — no Razorpay order. Carry
    // the booking id out so the caller can send the confirmation (there's no
    // payment webhook to do it).
    if (isFree) {
      return { kind: 'free' as const, userMembershipId: um.id, bookingId: b.id };
    }

    return {
      kind: 'paid' as const,
      bookingId: b.id,
      userMembershipId: um.id,
      tenantId: m.tenantId,
      totalPaise: breakdown.totalPaise,
      settleBasePaise,
      membershipId: m.id,
      payCtx,
    };
  });

  if (reserved.kind === 'free') {
    // Free purchases confirm inline (no capture webhook), so mint the QR
    // ticket here — keyed on the user_membership because the plain free path
    // has no bookings row. Idempotent, so the booking-keyed hook below (which
    // also issues) can't double-mint on the coupon-made-free path. Best-effort:
    // the purchase is already committed, so a QR hiccup must not fail it.
    try {
      await issueQrTicketsForUserMembership(reserved.userMembershipId, {
        bookingId: 'bookingId' in reserved ? (reserved.bookingId ?? null) : null,
      });
    } catch (err) {
      logger.warn(
        { err, userMembershipId: reserved.userMembershipId },
        'membership_qr_issue_failed',
      );
    }
    // Only the coupon-made-free path mints a booking row; the plain free path
    // has nothing for the booking-keyed notification helpers to anchor on.
    if ('bookingId' in reserved && reserved.bookingId) {
      await onBookingConfirmed(reserved.bookingId);
    }
    return { userMembershipId: reserved.userMembershipId };
  }

  // Phase 2 — paid: createPaymentOrder runs OUTSIDE the booking tx so the FK to
  // bookings is satisfied (createPaymentOrder inserts a payments row referencing
  // bookingId). Mirrors the bookEvent / prepareOnlineBookingWithPayment split.
  let orderId: string | undefined;
  let paymentId: string | undefined;
  let clientSecret: string | undefined;
  try {
    const result = await paymentsService.createPaymentOrder({
      bookingId: reserved.bookingId,
      tenantId: reserved.tenantId,
      amountPaise: reserved.totalPaise,
      settleBasePaise: reserved.settleBasePaise,
      provider: reserved.payCtx.provider,
      currency: reserved.payCtx.currency,
      actorUserId: input.userId,
    });
    orderId = result.providerOrderId;
    paymentId = result.paymentId;
    clientSecret = result.clientSecret;
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
    gateway: reserved.payCtx.provider,
    keyId: publicKeyIdFor(reserved.payCtx.provider),
    ...(clientSecret !== undefined ? { clientSecret } : {}),
    amountPaise: reserved.totalPaise,
    currency: reserved.payCtx.currency,
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
  /** The tier the user bought (null for legacy/no-tier purchases). */
  tier: { id: string; name: string; pricePaise: number; durationDays: number } | null;
  /** The member's QR entry pass, when the plan has QR tickets enabled. */
  qrTicket: {
    code: string;
    qrData: string;
    validFrom: string | null;
    validUntil: string | null;
    multiUse: boolean;
    maxScans: number | null;
    scanCount: number;
    status: string;
  } | null;
}

/** Returns the user's active memberships joined with the membership catalog row. */
export async function listUserMemberships(userId: string): Promise<UserMembershipWithMembership[]> {
  const rows = await db
    .select({
      um: userMemberships,
      m: memberships,
      t: membershipTiers,
      qr: qrTickets,
    })
    .from(userMemberships)
    .innerJoin(memberships, eq(userMemberships.membershipId, memberships.id))
    .leftJoin(membershipTiers, eq(userMemberships.membershipTierId, membershipTiers.id))
    .leftJoin(qrTickets, eq(qrTickets.userMembershipId, userMemberships.id))
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
      // Reflect the purchased tier when present; else the legacy plan fields.
      pricePaise: r.t?.pricePaise ?? r.m.pricePaise,
      durationDays: r.t?.durationDays ?? r.m.durationDays,
    },
    tier: r.t ? { id: r.t.id, name: r.t.name, pricePaise: r.t.pricePaise, durationDays: r.t.durationDays } : null,
    qrTicket: r.qr
      ? {
          code: r.qr.code,
          qrData: qrTicketDataUrl(r.qr.code),
          validFrom: r.qr.validFrom?.toISOString() ?? null,
          validUntil: r.qr.validUntil?.toISOString() ?? null,
          multiUse: r.qr.multiUse,
          maxScans: r.qr.maxScans,
          scanCount: r.qr.scanCount,
          status: r.qr.status,
        }
      : null,
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
): Promise<PartnerMembership> {
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
  return withCoverUrl(row);
}

export async function removeMembershipCover(
  tenantId: string,
  membershipId: string,
): Promise<PartnerMembership> {
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
  return withCoverUrl(row);
}

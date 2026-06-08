import { and, eq, getTableColumns, inArray, ne, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type Booking, bookings, slots, tenants } from '../db/schema/index.js';
import { events } from '../db/schema/events.js';
import { payments } from '../db/schema/payments.js';
import { env } from '../config/env.js';
import { BadRequest, Conflict, NotFound } from '../lib/errors.js';
import { type AuditCtx, writeAudit } from '../lib/audit.js';
import { createRouteOrder } from './payments_service.js';
import * as paymentsService from './payments_service.js';
import { computeCheckout } from './checkout_pricing.js';
import { recordRedemption } from './coupon_service.js';
import type { Coupon } from '../db/schema/coupons.js';

/** A resolved coupon + who funds the discount, threaded into the booking flows. */
export interface CouponPricing {
  coupon: Coupon;
  funder: 'org' | 'platform';
}

export interface BookSlotsInput {
  slotIds: string[];
  customerName: string;
  customerContact: string;
  note?: string | null;
}

export async function bookSlots(
  ctx: AuditCtx,
  venueId: string,
  input: BookSlotsInput,
): Promise<Booking> {
  if (input.slotIds.length === 0) throw new Conflict('No slots selected', 'no_slots');

  return db.transaction(async (tx) => {
    const sel = await tx
      .select({
        ...getTableColumns(slots),
        startsInPast: sql<boolean>`lower(${slots.timeRange}) <= now()`,
      })
      .from(slots)
      .where(
        and(
          inArray(slots.id, input.slotIds),
          eq(slots.tenantId, ctx.tenantId),
          sql`${slots.deletedAt} is null`,
        ),
      );

    // A slot whose start instant has passed can no longer be booked.
    if (sel.some((r) => r.startsInPast)) {
      throw new Conflict('This slot has already started', 'slot_in_past');
    }

    const total = sel.reduce((s, r) => s + r.pricePaise, 0);

    const [booking] = await tx
      .insert(bookings)
      .values({
        tenantId: ctx.tenantId,
        venueId,
        itemType: 'slot',
        channel: 'walkin',
        paymentMethod: 'external',
        status: 'confirmed',
        customerName: input.customerName,
        customerContact: input.customerContact,
        note: input.note ?? null,
        totalPaise: total,
        createdByUserId: ctx.actorUserId,
      })
      .returning();

    // Atomic claim: take slots that are open, OR held by the booking actor
    // (their own active hold), OR held-but-expired (reclaimable from anyone).
    // Using inArray() avoids the any(array::uuid[]) record-cast error from postgres-js.
    // eq(slots.tenantId, ctx.tenantId) guards against cross-tenant slot injection:
    // a member of tenant A passing slotIds from tenant B would otherwise claim B's slots.
    const claimed = await tx
      .update(slots)
      .set({ status: 'booked', bookingId: booking!.id, holdExpiresAt: null, heldByUserId: null })
      .where(
        and(
          inArray(slots.id, input.slotIds),
          eq(slots.tenantId, ctx.tenantId),
          sql`${slots.deletedAt} is null`,
          // TOCTOU guard: never claim a slot whose start has passed.
          sql`lower(${slots.timeRange}) > now()`,
          or(
            eq(slots.status, 'open'),
            and(
              eq(slots.status, 'held'),
              or(eq(slots.heldByUserId, ctx.actorUserId), sql`${slots.holdExpiresAt} < now()`),
            ),
          ),
        ),
      )
      .returning();

    if (claimed.length !== input.slotIds.length) {
      throw new Conflict('Slot already taken', 'slot_taken');
    }

    // Persist the booking's own arena + time-span so that cancelled bookings
    // (which null slots.booking_id) still have an arena + window the read paths
    // can fall back to. Single-arena booking model: all claimed slots must
    // share one arena — assert so future multi-arena designs surface loudly.
    const claimedArenaId = claimed[0]!.arenaId;
    if (!claimed.every((c) => c.arenaId === claimedArenaId)) {
      throw new Conflict('Multi-arena booking not supported', 'multi_arena_booking');
    }

    await tx
      .update(bookings)
      .set({
        slotArenaId: claimedArenaId,
        // The sub-SELECT computes the span from the slots we just linked
        // (booking_id was set in the UPDATE above), as their definitive span.
        timeRange: sql`(select tstzrange(min(lower(time_range)), max(upper(time_range)), '[)') from slots where booking_id = ${booking!.id})`,
      })
      .where(eq(bookings.id, booking!.id));

    await writeAudit(tx, ctx, 'booking.create', 'booking', booking!.id, null, {
      slotIds: input.slotIds,
      total,
    });

    return booking!;
  });
}

/**
 * Online-booking (Channel A) preparation. Phase 12 (Track B).
 *
 * Difference vs walk-in `bookSlots()`:
 *   - the bookings row goes in as `status='pending'` + `channel='circls'` +
 *     `paymentMethod='razorpay_route'`; it only transitions to `confirmed`
 *     when the `payment.captured` webhook fires.
 *   - the slots are still claimed atomically (to prevent two carts from
 *     colliding), but with `status='booked'` and `booking_id` pointing at the
 *     pending booking — abandoned-cart sweep frees them again if no capture
 *     arrives within `ABANDONED_CART_GRACE_MIN`.
 *   - a Razorpay order (Circls as merchant) is created via
 *     `payments_service.createRouteOrder` and its id is returned so the frontend
 *     can hand off to Razorpay's checkout. Commission is taken at payout time,
 *     not at order time.
 *
 * Returns `{ bookingId, payment: { orderId, keyId } }` so the partner-portal /
 * consumer app has the minimum payload to open Razorpay's checkout widget.
 */
export interface PrepareOnlineBookingInput {
  slotIds: string[];
  customerName: string;
  customerContact: string;
  note?: string | null;
}

export interface PrepareOnlineBookingResult {
  bookingId: string;
  payment: {
    orderId: string;
    keyId: string;
    amountPaise: number;
    currency: 'INR';
  };
}

export async function prepareOnlineBookingWithPayment(
  ctx: AuditCtx,
  venueId: string,
  input: PrepareOnlineBookingInput,
  pricing?: CouponPricing | null,
): Promise<PrepareOnlineBookingResult> {
  if (input.slotIds.length === 0) throw new Conflict('No slots selected', 'no_slots');

  // Same claim flow as walk-in, but staged: bookings.status='pending', and we
  // capture the price total so the Razorpay order has the right paise amount.
  const { bookingId, totalPaise, settleBasePaise, isFree } = await db.transaction(async (tx) => {
    const sel = await tx
      .select({
        ...getTableColumns(slots),
        startsInPast: sql<boolean>`lower(${slots.timeRange}) <= now()`,
      })
      .from(slots)
      .where(
        and(
          inArray(slots.id, input.slotIds),
          eq(slots.tenantId, ctx.tenantId),
          sql`${slots.deletedAt} is null`,
        ),
      );

    if (sel.length !== input.slotIds.length) {
      throw new NotFound('Slot not found', 'slot_not_found');
    }
    if (sel.some((r) => r.startsInPast)) {
      throw new Conflict('This slot has already started', 'slot_in_past');
    }

    const total = sel.reduce((s, r) => s + r.pricePaise, 0);

    // Money model: discount + gross-up. A 100%/over-base coupon makes the
    // booking free (skip Razorpay). settleBase is the org's payout base: full
    // base when platform-funded, discounted base when org-funded.
    const breakdown = computeCheckout(
      total,
      pricing
        ? {
            discountType: pricing.coupon.discountType,
            discountValue: pricing.coupon.discountValue,
            maxDiscountPaise: pricing.coupon.maxDiscountPaise,
          }
        : null,
    );
    const free = breakdown.totalPaise === 0;
    const settleBase = pricing && pricing.funder === 'platform' ? total : breakdown.discountedBasePaise;

    // Circls is the merchant — the customer's payment lands in Circls's account.
    // No per-tenant KYC / Linked Account gate; the venue is paid out weekly,
    // net of commission, via the payouts workflow.
    const [booking] = await tx
      .insert(bookings)
      .values({
        tenantId: ctx.tenantId,
        venueId,
        itemType: 'slot',
        channel: 'circls',
        paymentMethod: free ? 'free' : 'razorpay_route',
        status: free ? 'confirmed' : 'pending',
        customerName: input.customerName,
        customerContact: input.customerContact,
        note: input.note ?? null,
        basePaise: total,
        discountPaise: breakdown.discountPaise,
        couponId: pricing?.coupon.id ?? null,
        totalPaise: breakdown.totalPaise,
        createdByUserId: ctx.actorUserId,
      })
      .returning();

    // Atomic claim — same rules as walk-in (open / own-hold / expired-hold).
    const claimed = await tx
      .update(slots)
      .set({ status: 'booked', bookingId: booking!.id, holdExpiresAt: null, heldByUserId: null })
      .where(
        and(
          inArray(slots.id, input.slotIds),
          eq(slots.tenantId, ctx.tenantId),
          sql`${slots.deletedAt} is null`,
          sql`lower(${slots.timeRange}) > now()`,
          or(
            eq(slots.status, 'open'),
            and(
              eq(slots.status, 'held'),
              or(eq(slots.heldByUserId, ctx.actorUserId), sql`${slots.holdExpiresAt} < now()`),
            ),
          ),
        ),
      )
      .returning();

    if (claimed.length !== input.slotIds.length) {
      throw new Conflict('Slot already taken', 'slot_taken');
    }

    const claimedArenaId = claimed[0]!.arenaId;
    if (!claimed.every((c) => c.arenaId === claimedArenaId)) {
      throw new Conflict('Multi-arena booking not supported', 'multi_arena_booking');
    }

    await tx
      .update(bookings)
      .set({
        slotArenaId: claimedArenaId,
        timeRange: sql`(select tstzrange(min(lower(time_range)), max(upper(time_range)), '[)') from slots where booking_id = ${booking!.id})`,
      })
      .where(eq(bookings.id, booking!.id));

    // When a coupon applies, record the redemption inside the booking tx so a
    // lost cap race rolls the whole booking back (and frees the claimed slots).
    if (pricing) {
      await recordRedemption(tx, {
        coupon: pricing.coupon,
        bookingId: booking!.id,
        userId: ctx.actorUserId,
        tenantId: ctx.tenantId,
        basePaise: total,
        discountPaise: breakdown.discountPaise,
        funder: pricing.funder,
      });
    }

    await writeAudit(tx, ctx, 'booking.create_pending', 'booking', booking!.id, null, {
      slotIds: input.slotIds,
      total,
      discountPaise: breakdown.discountPaise,
      totalPaise: breakdown.totalPaise,
      free,
      channel: 'circls',
      paymentMethod: free ? 'free' : 'razorpay_route',
    });

    return {
      bookingId: booking!.id,
      totalPaise: breakdown.totalPaise,
      settleBasePaise: settleBase,
      isFree: free,
    };
  });

  // Free booking (e.g. a 100%-off coupon): no Razorpay order, no payment row.
  if (isFree) {
    return {
      bookingId,
      payment: { orderId: '', keyId: '', amountPaise: 0, currency: 'INR' },
    };
  }

  // Create the order outside the booking transaction so a network blip talking
  // to Razorpay doesn't roll back the pending booking + slot claim. If
  // createRouteOrder ultimately fails, the abandoned-cart sweep will clean the
  // pending booking after the grace window.
  const { paymentId: _paymentId, providerOrderId } = await createRouteOrder({
    bookingId,
    tenantId: ctx.tenantId,
    amountPaise: totalPaise,
    settleBasePaise,
    actorUserId: ctx.actorUserId,
  });

  return {
    bookingId,
    payment: {
      orderId: providerOrderId,
      // Frontend uses this with Razorpay checkout JS. Stub mode has no key id;
      // we surface an empty string so the response shape stays stable.
      keyId: env.RAZORPAY_KEY_ID ?? '',
      amountPaise: totalPaise,
      currency: 'INR',
    },
  };
}

export async function cancelBooking(ctx: AuditCtx, bookingId: string): Promise<Booking> {
  return db.transaction(async (tx) => {
    const [b] = await tx
      .update(bookings)
      .set({ status: 'cancelled' })
      .where(
        and(eq(bookings.id, bookingId), eq(bookings.tenantId, ctx.tenantId)),
      )
      .returning();

    if (!b) throw new NotFound('Booking not found', 'booking_not_found');

    await tx
      .update(slots)
      .set({ status: 'open', bookingId: null })
      .where(and(eq(slots.bookingId, bookingId), sql`${slots.deletedAt} is null`));

    await writeAudit(tx, ctx, 'booking.cancel', 'booking', bookingId, null, null);

    return b;
  });
}

// ── Event bookings (Phase 15) ───────────────────────────────────────────────

export interface BookEventCustomer {
  /** The authenticated user purchasing the seat. */
  userId: string;
  /** Display name persisted on the booking for reception lookup. */
  name?: string | null;
  /** Phone / email kept for notifications + walk-up reconciliation. */
  contact?: string | null;
  note?: string | null;
}

export type BookEventPaymentMethod = 'razorpay_route' | 'external' | 'free';

export interface BookEventResult {
  booking: Booking;
  paymentId?: string;
  providerOrderId?: string;
  /** Razorpay publishable key + amount, so the client can open checkout. */
  keyId?: string;
  amountPaise?: number;
}

/**
 * Book a seat on a published event.
 *
 * Capacity check:
 *   - When event.capacity IS NOT NULL we COUNT non-cancelled bookings whose
 *     itemData->>'eventId' matches and reject if we'd exceed `capacity`. We
 *     do this inside the same transaction that performs the insert so two
 *     concurrent calls can't both squeeze under the limit; we additionally
 *     re-COUNT after the insert and roll back if the post-insert count is
 *     over capacity, which is the simple form of "select-then-insert with
 *     verification" — no GIST exclusion constraint exists for events because
 *     they aren't time-range based.
 *
 * Free path  (pricePaise === 0): inserts booking with status='confirmed',
 *   paymentMethod='free'. No KYC check.
 *
 * Paid path: Circls is the merchant (no per-tenant KYC / Linked Account).
 *   Inserts booking status='pending' + payments row kind='charge', then calls
 *   `payments_service.createRouteOrder`. If Phase 12 isn't ready, surfaces a
 *   `payment_not_available` Conflict (the wrapping transaction rolls back).
 */
export async function bookEvent(
  eventId: string,
  customer: BookEventCustomer,
  pricing?: CouponPricing | null,
): Promise<BookEventResult> {
  // Phase 1 — atomic seat reservation. The booking row goes into the DB inside
  // a transaction so capacity check + insert are race-safe.
  const reserved = await db.transaction(async (tx) => {
    const [ev] = await tx
      .select()
      .from(events)
      .where(eq(events.id, eventId))
      .limit(1);
    if (!ev) throw new NotFound('Event not found', 'event_not_found');
    if (ev.status !== 'published') {
      throw new Conflict('Event is not published', 'event_not_published');
    }
    const ctx: AuditCtx = { tenantId: ev.tenantId, actorUserId: customer.userId };

    if (ev.capacity !== null) {
      const rows = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(bookings)
        .where(
          and(
            eq(bookings.itemType, 'event'),
            sql`${bookings.itemData}->>'eventId' = ${eventId}`,
            ne(bookings.status, 'cancelled'),
          ),
        );
      const n = rows[0]?.n ?? 0;
      if (n >= ev.capacity) {
        throw new Conflict('Event is at capacity', 'event_full');
      }
    }

    // Money model: discount + gross-up. A 100%/over-base coupon can make a paid
    // event free, so derive isFree from the grossed-up total, not the base.
    const basePaise = ev.pricePaise;
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
    // Circls is the merchant — no per-tenant KYC / Linked Account gate.

    const [b] = await tx
      .insert(bookings)
      .values({
        tenantId: ev.tenantId,
        venueId: ev.venueId,
        itemType: 'event',
        channel: 'circls',
        paymentMethod: isFree ? 'free' : 'razorpay_route',
        status: isFree ? 'confirmed' : 'pending',
        customerUserId: customer.userId,
        customerName: customer.name ?? null,
        customerContact: customer.contact ?? null,
        note: customer.note ?? null,
        pricePaise: basePaise,
        basePaise,
        discountPaise: breakdown.discountPaise,
        couponId: pricing?.coupon.id ?? null,
        totalPaise: breakdown.totalPaise,
        itemData: { eventId: ev.id, eventName: ev.name },
        createdByUserId: ctx.actorUserId,
      })
      .returning();
    if (!b) throw new Error('booking insert returned no row');

    if (ev.capacity !== null) {
      const rows2 = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(bookings)
        .where(
          and(
            eq(bookings.itemType, 'event'),
            sql`${bookings.itemData}->>'eventId' = ${eventId}`,
            ne(bookings.status, 'cancelled'),
          ),
        );
      const n2 = rows2[0]?.n ?? 0;
      if (n2 > ev.capacity) {
        throw new Conflict('Event is at capacity', 'event_full');
      }
    }

    // Record the redemption inside the same tx so a lost cap race rolls the
    // booking (and capacity claim) back together.
    if (pricing) {
      await recordRedemption(tx, {
        coupon: pricing.coupon,
        bookingId: b.id,
        userId: customer.userId,
        tenantId: ev.tenantId,
        basePaise,
        discountPaise: breakdown.discountPaise,
        funder: pricing.funder,
      });
    }

    await writeAudit(tx, ctx, 'event.booked', 'booking', b.id, null, {
      eventId: ev.id,
      free: isFree,
    });

    return {
      booking: b,
      isFree,
      tenantId: ev.tenantId,
      eventName: ev.name,
      totalPaise: breakdown.totalPaise,
      settleBasePaise,
    };
  });

  if (reserved.isFree) {
    return { booking: reserved.booking };
  }

  // Phase 2 — paid path: createRouteOrder runs OUTSIDE the booking tx so it can
  // see the committed booking row (it inserts payments referencing it). Mirrors
  // prepareOnlineBookingWithPayment's split-tx pattern; if Razorpay fails here,
  // the abandoned-cart sweep cancels the pending booking after the grace window.
  let providerOrderId: string | undefined;
  let paymentId: string | undefined;
  try {
    const result = await paymentsService.createRouteOrder({
      bookingId: reserved.booking.id,
      tenantId: reserved.tenantId,
      amountPaise: reserved.totalPaise,
      settleBasePaise: reserved.settleBasePaise,
      actorUserId: customer.userId,
    });
    providerOrderId = result.providerOrderId;
    paymentId = result.paymentId;
  } catch (err) {
    if (err instanceof Error && err.message.includes('not implemented')) {
      throw new Conflict('Payments not yet enabled', 'payment_not_available');
    }
    throw err;
  }

  return {
    booking: reserved.booking,
    paymentId,
    providerOrderId,
    keyId: env.RAZORPAY_KEY_ID ?? '',
    amountPaise: reserved.totalPaise,
  };
}

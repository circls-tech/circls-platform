import { and, eq, getTableColumns, inArray, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type Booking, bookings, slots, tenants } from '../db/schema/index.js';
import { env } from '../config/env.js';
import { BadRequest, Conflict, NotFound } from '../lib/errors.js';
import { type AuditCtx, writeAudit } from '../lib/audit.js';
import { createRouteOrder } from './payments_service.js';

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
 *   - a Razorpay Route order is created via `payments_service.createRouteOrder`
 *     and its id is returned so the frontend can hand off to Razorpay's
 *     checkout. The platform fee is configurable (default = 0 here; phase 16
 *     wires per-tenant commission).
 *
 * Returns `{ bookingId, payment: { orderId, keyId } }` so the partner-portal /
 * consumer app has the minimum payload to open Razorpay's checkout widget.
 */
export interface PrepareOnlineBookingInput {
  slotIds: string[];
  customerName: string;
  customerContact: string;
  note?: string | null;
  /** Optional override; defaults to 0 (Phase 16 owns tenant-level commission). */
  platformFeePaise?: number;
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
): Promise<PrepareOnlineBookingResult> {
  if (input.slotIds.length === 0) throw new Conflict('No slots selected', 'no_slots');

  // Same claim flow as walk-in, but staged: bookings.status='pending', and we
  // capture the price total so the Razorpay order has the right paise amount.
  const { bookingId, totalPaise, linkedAccountId } = await db.transaction(async (tx) => {
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

    // We require the tenant to be KYC-verified (i.e. has a Linked Account)
    // before we can route a payment to them. Phase 11 owns the KYC flow.
    const [tenantRow] = await tx
      .select({
        razorpayLinkedAccountId: tenants.razorpayLinkedAccountId,
      })
      .from(tenants)
      .where(eq(tenants.id, ctx.tenantId))
      .limit(1);
    if (!tenantRow?.razorpayLinkedAccountId) {
      throw new BadRequest(
        'Tenant has no Razorpay Linked Account',
        'tenant_not_payments_ready',
      );
    }

    const [booking] = await tx
      .insert(bookings)
      .values({
        tenantId: ctx.tenantId,
        venueId,
        itemType: 'slot',
        channel: 'circls',
        paymentMethod: 'razorpay_route',
        status: 'pending',
        customerName: input.customerName,
        customerContact: input.customerContact,
        note: input.note ?? null,
        totalPaise: total,
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

    await writeAudit(tx, ctx, 'booking.create_pending', 'booking', booking!.id, null, {
      slotIds: input.slotIds,
      total,
      channel: 'circls',
      paymentMethod: 'razorpay_route',
    });

    return {
      bookingId: booking!.id,
      totalPaise: total,
      linkedAccountId: tenantRow.razorpayLinkedAccountId,
    };
  });

  // Create the Route order outside the booking transaction so a network blip
  // talking to Razorpay doesn't roll back the pending booking + slot claim.
  // If Razorpay createRouteOrder ultimately fails, the abandoned-cart sweep
  // will clean the pending booking after the grace window.
  const { paymentId: _paymentId, providerOrderId } = await createRouteOrder({
    bookingId,
    tenantId: ctx.tenantId,
    amountPaise: totalPaise,
    linkedAccountId,
    platformFeePaise: input.platformFeePaise ?? 0,
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
